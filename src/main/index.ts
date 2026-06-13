import { app, shell, BrowserWindow, ipcMain, dialog, Menu, clipboard } from 'electron'
import { join, basename } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

interface OpenedFile {
  name: string
  data: Uint8Array
}

// Test harnesses set this to isolate the instance — userData also scopes
// the single-instance lock, so an override avoids colliding with a dev run.
if (process.env.PDFX_USER_DATA) {
  app.setPath('userData', process.env.PDFX_USER_DATA)
}

let mainWindow: BrowserWindow | null = null
let rendererReady = false
let pendingOpenPaths: string[] = []

function collectFileArgs(argv: string[]): string[] {
  return argv.filter((arg) => /\.(pdf|pdfx)$/i.test(arg) && existsSync(arg))
}

const IMPORTABLE = /\.(pdf|pdfx|png|jpe?g|webp|gif|bmp|avif)$/i

// Files copied in Finder/Explorer land on the clipboard as path references
// (plus a preview icon, which is why readImage() alone shows generic thumbnails).
function clipboardFilePaths(): string[] {
  const paths: string[] = []
  if (process.platform === 'darwin') {
    const plist = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8')
    for (const match of plist.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
      paths.push(match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    }
    if (paths.length === 0) {
      const url = clipboard.read('public.file-url')
      if (url?.startsWith('file://')) paths.push(decodeURIComponent(new URL(url).pathname))
    }
  } else if (process.platform === 'win32') {
    const buffer = clipboard.readBuffer('FileNameW')
    if (buffer.length > 0) {
      const path = buffer.toString('ucs2').replace(/\0+$/g, '')
      if (path) paths.push(path)
    }
  } else {
    for (const line of clipboard.readText().split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('file://')) paths.push(decodeURIComponent(new URL(trimmed).pathname))
    }
  }
  return paths
}

async function readFiles(paths: string[]): Promise<OpenedFile[]> {
  return Promise.all(
    paths.map(async (p) => ({ name: basename(p), data: new Uint8Array(await readFile(p)) }))
  )
}

async function sendOpenPaths(paths: string[]): Promise<void> {
  if (!mainWindow || paths.length === 0) return
  mainWindow.webContents.send('pdfx:files-opened', await readFiles(paths))
}

// All document logic lives in the renderer; the menu only provides native
// items and accelerators, forwarded over IPC.
function buildMenu(): void {
  const sendZoom = (action: 'in' | 'out' | 'reset') => (): void => {
    mainWindow?.webContents.send('pdfx:zoom', action)
  }
  const sendMenu = (action: string) => (): void => {
    mainWindow?.webContents.send('pdfx:menu', action)
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { id: 'open', label: 'Open…', accelerator: 'CommandOrControl+O', click: sendMenu('open') },
        { type: 'separator' },
        {
          id: 'export-pdfx',
          label: 'Export .pdfx…',
          accelerator: 'CommandOrControl+E',
          click: sendMenu('export-pdfx')
        },
        { id: 'export-pdf', label: 'Export Single PDF…', click: sendMenu('export-pdf') },
        { id: 'export-zip', label: 'Export All as ZIP…', click: sendMenu('export-zip') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          id: 'zoom-in',
          label: 'Zoom In',
          accelerator: 'CommandOrControl+=',
          click: sendZoom('in')
        },
        {
          id: 'zoom-out',
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: sendZoom('out')
        },
        {
          id: 'zoom-reset',
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: sendZoom('reset')
        },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f5',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 19 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// macOS: files opened via Finder / file association
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (rendererReady) {
    void sendOpenPaths([path])
  } else {
    pendingOpenPaths.push(path)
  }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    void sendOpenPaths(collectFileArgs(argv.slice(1)))
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.pdfx.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    pendingOpenPaths.push(...collectFileArgs(process.argv.slice(1)))

    ipcMain.handle('pdfx:renderer-ready', async () => {
      rendererReady = true
      const paths = pendingOpenPaths
      pendingOpenPaths = []
      await sendOpenPaths(paths)
    })

    ipcMain.handle(
      'pdfx:choose-save-path',
      async (_event, defaultName: string, filter?: { name: string; extensions: string[] }) => {
        if (!mainWindow) return null
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Export',
          defaultPath: defaultName,
          filters: [filter ?? { name: 'PDFX', extensions: ['pdfx'] }]
        })
        return result.canceled || !result.filePath ? null : result.filePath
      }
    )

    ipcMain.handle('pdfx:read-clipboard-image', () => {
      const image = clipboard.readImage()
      return image.isEmpty() ? null : new Uint8Array(image.toPNG())
    })

    ipcMain.handle('pdfx:read-clipboard-files', async (): Promise<OpenedFile[]> => {
      const paths = clipboardFilePaths().filter((p) => IMPORTABLE.test(p) && existsSync(p))
      return readFiles(paths)
    })

    ipcMain.handle('pdfx:clipboard-clear', () => clipboard.clear())

    ipcMain.handle('pdfx:write-file', async (_event, path: string, data: Uint8Array) => {
      await writeFile(path, data)
      return basename(path)
    })

    ipcMain.handle('pdfx:open-files', async (): Promise<OpenedFile[]> => {
      if (!mainWindow) return []
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open PDF, PDFX, or Image',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'PDF, PDFX & Images',
            extensions: ['pdf', 'pdfx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']
          },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result.canceled) return []
      return readFiles(result.filePaths)
    })

    buildMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
