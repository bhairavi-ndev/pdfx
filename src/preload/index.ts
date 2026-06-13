import { contextBridge, ipcRenderer } from 'electron'

export interface OpenedFile {
  name: string
  data: Uint8Array
}

export type ZoomAction = 'in' | 'out' | 'reset'

export type MenuAction = 'open' | 'export-pdfx' | 'export-pdf' | 'export-zip'

export interface SaveFilter {
  name: string
  extensions: string[]
}

const api = {
  platform: process.platform,
  rendererReady: (): Promise<void> => ipcRenderer.invoke('pdfx:renderer-ready'),
  chooseSavePath: (defaultName: string, filter?: SaveFilter): Promise<string | null> =>
    ipcRenderer.invoke('pdfx:choose-save-path', defaultName, filter),
  readClipboardImage: (): Promise<Uint8Array | null> =>
    ipcRenderer.invoke('pdfx:read-clipboard-image'),
  readClipboardFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('pdfx:read-clipboard-files'),
  clearClipboard: (): Promise<void> => ipcRenderer.invoke('pdfx:clipboard-clear'),
  writeFile: (path: string, data: Uint8Array): Promise<string> =>
    ipcRenderer.invoke('pdfx:write-file', path, data),
  openFiles: (): Promise<OpenedFile[]> => ipcRenderer.invoke('pdfx:open-files'),
  onFilesOpened: (callback: (files: OpenedFile[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, files: OpenedFile[]): void =>
      callback(files)
    ipcRenderer.on('pdfx:files-opened', listener)
    return () => ipcRenderer.removeListener('pdfx:files-opened', listener)
  },
  onZoom: (callback: (action: ZoomAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: ZoomAction): void =>
      callback(action)
    ipcRenderer.on('pdfx:zoom', listener)
    return () => ipcRenderer.removeListener('pdfx:zoom', listener)
  },
  onMenu: (callback: (action: MenuAction) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MenuAction): void =>
      callback(action)
    ipcRenderer.on('pdfx:menu', listener)
    return () => ipcRenderer.removeListener('pdfx:menu', listener)
  }
}

export type PdfxApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in d.ts)
  window.api = api
}
