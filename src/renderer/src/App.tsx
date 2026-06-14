import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getDocument } from 'pdfjs-dist'
import { zipSync } from 'fflate'
import { buildPdf, buildPdfx, partitionPages, readManifest, stripExtension } from './pdfx/format'
import { imageToPdf, isImageBytes, isImageFile, stripImageExtension } from './pdfx/images'
import type { DocEntry, PageEntry, PdfSource } from './types'
import { Toolbar } from './components/Toolbar'
import { DocumentRow } from './components/DocumentRow'
import { EmptyState } from './components/EmptyState'
import { FullView } from './components/FullView'

interface IncomingFile {
  name: string
  data: Uint8Array
}

interface PageRef {
  docId: string
  pageId: string
}

const toExportPage = (
  page: PageEntry
): { sourceKey: string; bytes: Uint8Array; pageIndex: number } => ({
  sourceKey: page.source.id,
  bytes: page.source.bytes,
  pageIndex: page.pageIndex
})

/**
 * Offset model ("invisible container"): per axis, content may transiently
 * overflow past its start edge (translate < 0) but may NEVER detach from its
 * dock leaving a gap (translate > 0 is forbidden). The offset lives in
 * native scroll whenever scroll range exists; the translate only carries
 * what scroll cannot represent — needed because scrollLeft/scrollTop clamp
 * at 0, so when content fits the viewport there is no scroll range at all
 * and cursor-anchored zoom would otherwise be impossible. Leftover translate
 * is folded back into scroll and glided to the dock when zooming goes idle
 * (redockAxis), so content can never be stranded off-screen.
 */

function writeTransform(inner: HTMLElement): void {
  const tx = Number(inner.dataset.tx ?? 0)
  const ty = Number(inner.dataset.ty ?? 0)
  inner.style.transform = tx || ty ? `translate(${tx}px, ${ty}px)` : ''
}

// Stop a running re-dock glide, committing its current visual position so a
// resumed zoom takes over without a jump.
function settleAnimations(inner: HTMLElement): void {
  const animations = inner.getAnimations()
  if (animations.length === 0) return
  const computed = getComputedStyle(inner).transform
  const matrix = new DOMMatrixReadOnly(computed === 'none' ? undefined : computed)
  animations.forEach((animation) => animation.cancel())
  inner.dataset.tx = String(matrix.m41)
  inner.dataset.ty = String(matrix.m42)
  writeTransform(inner)
}

function maxScrollOf(scroller: HTMLElement, horizontal: boolean): number {
  return Math.max(
    0,
    horizontal
      ? scroller.scrollWidth - scroller.clientWidth
      : scroller.scrollHeight - scroller.clientHeight
  )
}

function contentOffset(scroller: HTMLElement, inner: HTMLElement, axis: 'x' | 'y'): number {
  settleAnimations(inner)
  const horizontal = axis === 'x'
  const translate = Number(inner.dataset[horizontal ? 'tx' : 'ty'] ?? 0)
  return translate - (horizontal ? scroller.scrollLeft : scroller.scrollTop)
}

/** Shift content along one axis by `delta` viewport pixels, within bounds. */
function shiftAxis(
  scroller: HTMLElement,
  inner: HTMLElement,
  axis: 'x' | 'y',
  delta: number
): void {
  settleAnimations(inner)
  const horizontal = axis === 'x'
  const key = horizontal ? 'tx' : 'ty'
  const scrollPos = horizontal ? scroller.scrollLeft : scroller.scrollTop
  const translate = Number(inner.dataset[key] ?? 0)
  // Desired content offset relative to the scrollport start.
  const target = translate - scrollPos + delta
  const nextScroll = Math.min(Math.max(-target, 0), maxScrollOf(scroller, horizontal))
  // Gap side is pinned to the dock (never positive); the hidden side keeps
  // what scroll can't represent, recovered later by the idle re-dock.
  const nextTranslate = Math.min(0, target + nextScroll)

  if (horizontal) scroller.scrollLeft = nextScroll
  else scroller.scrollTop = nextScroll
  inner.dataset[key] = String(nextTranslate)
  writeTransform(inner)
}

/** Fold leftover translate into native scroll, then glide the rest to the dock. */
function redockAxis(scroller: HTMLElement, inner: HTMLElement, axis: 'x' | 'y'): void {
  settleAnimations(inner)
  const horizontal = axis === 'x'
  const key = horizontal ? 'tx' : 'ty'
  const translate = Number(inner.dataset[key] ?? 0)
  if (translate === 0) return
  const scrollPos = horizontal ? scroller.scrollLeft : scroller.scrollTop
  // Fold what native scroll can absorb — visually a no-op.
  const fold = Math.min(-translate, maxScrollOf(scroller, horizontal) - scrollPos)
  const remainder = translate + fold
  if (horizontal) scroller.scrollLeft = scrollPos + fold
  else scroller.scrollTop = scrollPos + fold
  inner.dataset[key] = '0'
  writeTransform(inner)
  if (Math.abs(remainder) > 0.5) {
    const tx = Number(inner.dataset.tx ?? 0)
    const ty = Number(inner.dataset.ty ?? 0)
    const from = horizontal
      ? `translate(${remainder}px, ${ty}px)`
      : `translate(${tx}px, ${remainder}px)`
    const to = `translate(${tx}px, ${ty}px)`
    inner.animate([{ transform: from }, { transform: to }], {
      duration: 260,
      easing: 'cubic-bezier(0.2, 0, 0, 1)'
    })
  }
}

const BASE_PAGE_HEIGHT = 300
// Min is generous on purpose: a birds-eye view fitting 10+ documents vertically.
const MIN_ZOOM = 0.06
const MAX_ZOOM = 4
const ZOOM_STEP = 1.25
// Below this the list switches to a compact layout tuned for overviews.
const COMPACT_ZOOM = 0.4

// Load PDF bytes into a shared source. Sources stay alive for the session,
// since page references (including the clipboard) may outlive their row.
async function loadSource(
  bytes: Uint8Array
): Promise<{ source: PdfSource; sizes: { width: number; height: number }[] }> {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const pdf = await getDocument({ data: bytes.slice() }).promise
  const source: PdfSource = { id: crypto.randomUUID(), bytes, pdf }
  const sizes: { width: number; height: number }[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    sizes.push({ width: viewport.width, height: viewport.height })
  }
  return { source, sizes }
}

function pagesFromSource(
  source: PdfSource,
  sizes: { width: number; height: number }[],
  indices: number[]
): PageEntry[] {
  return indices.map((pageIndex) => ({
    id: crypto.randomUUID(),
    source,
    pageIndex,
    width: sizes[pageIndex].width,
    height: sizes[pageIndex].height
  }))
}

// Import a .pdf/.pdfx into document entries.
async function importIntoDocs(filename: string, bytes: Uint8Array): Promise<DocEntry[]> {
  const { source, sizes } = await loadSource(bytes)
  const manifest = await readManifest(source.pdf)
  return partitionPages(manifest, source.pdf.numPages, stripExtension(filename)).map((part) => ({
    id: crypto.randomUUID(),
    name: part.name,
    pages: pagesFromSource(source, sizes, part.indices)
  }))
}

export default function App(): React.JSX.Element {
  const [docs, setDocs] = useState<DocEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<PageRef | null>(null)
  const [fullView, setFullView] = useState<PageRef | null>(null)
  const [draggingPage, setDraggingPage] = useState<PageRef | null>(null)
  // Insertion gap shown while a page from another document hovers a row.
  const [dropHint, setDropHint] = useState<{ docId: string; index: number } | null>(null)
  const clipboardRef = useRef<PageEntry | null>(null)
  const dragDepth = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<HTMLElement>(null)
  const zoomRef = useRef(1)
  const zoomAnchor = useRef<{
    /** Zoom the DOM actually reflects (the last committed one). */
    prev: number
    /** Anchor point in viewport coordinates. */
    x: number
    y: number
    /** Hovered strip and page, for exact element-based correction. */
    strip: HTMLElement | null
    page: HTMLElement | null
    /** Horizontal fraction of the cursor across the page (may extrapolate past 0..1). */
    pageFrac: number
    /** Cursor offset from the hovered strip's top edge. */
    stripOffsetY: number
  } | null>(null)

  const flash = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(null), 4000)
  }, [])

  // When the zoom gesture goes idle, glide any content that's overflowing
  // past its start edge back to the dock — nothing can stay stranded.
  const redockTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const redockAll = useCallback(() => {
    const content = contentRef.current
    if (!content) return
    const docList = content.querySelector<HTMLElement>('.doc-list')
    if (docList) redockAxis(content, docList, 'y')
    content.querySelectorAll<HTMLElement>('.page-strip').forEach((strip) => {
      const inner = strip.firstElementChild as HTMLElement | null
      if (inner) redockAxis(strip, inner, 'x')
    })
  }, [])

  // Change zoom keeping `anchor` (viewport coords, default: center) visually fixed.
  const applyZoom = useCallback(
    (next: number, anchor?: { x: number; y: number }) => {
      const prev = zoomRef.current
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
      if (clamped === prev) return
      const content = contentRef.current
      // Capture the anchor ONCE per commit. Under load several wheel events
      // coalesce into one render; re-capturing would record an intermediate
      // zoom the DOM never showed, under-correcting the scroll (the classic
      // "drift to a previous page" bug).
      if (content && !zoomAnchor.current) {
        const rect = content.getBoundingClientRect()
        const x = anchor ? anchor.x : rect.left + rect.width / 2
        const y = anchor ? anchor.y : rect.top + rect.height / 2

        // Find the strip and page under the anchor for exact correction.
        // elementsFromPoint pierces overlays like the sticky headers.
        let strip: HTMLElement | null = null
        let page: HTMLElement | null = null
        for (const el of document.elementsFromPoint(x, y)) {
          if (!(el instanceof HTMLElement)) continue
          if (!page && el.matches('.page')) page = el
          if (el.matches('.page-strip')) {
            strip = el
            break
          }
        }
        if (strip && !page) {
          // Cursor over a gap: anchor to the nearest page in this strip.
          let bestDistance = Infinity
          strip.querySelectorAll<HTMLElement>('[data-page-id]').forEach((el) => {
            const r = el.getBoundingClientRect()
            const distance = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
            if (distance < bestDistance) {
              bestDistance = distance
              page = el
            }
          })
        }
        const pageRect = page?.getBoundingClientRect()
        zoomAnchor.current = {
          prev,
          x,
          y,
          strip,
          page,
          pageFrac: pageRect ? (x - pageRect.left) / Math.max(1, pageRect.width) : 0,
          stripOffsetY: strip ? y - strip.getBoundingClientRect().top : 0
        }
      }
      zoomRef.current = clamped
      setZoom(clamped)
      if (redockTimer.current) clearTimeout(redockTimer.current)
      redockTimer.current = setTimeout(redockAll, 300)
    },
    [redockAll]
  )

  // After the DOM reflows at the new size, correct positions so the anchor
  // point stays put. The hovered strip is corrected exactly via the anchored
  // page element (fixed paddings/gaps make proportional scaling drift);
  // everything else falls back to proportional. All shifts go through
  // shiftAxis, which keeps anchoring exact even when content fits the
  // viewport and native scroll has no range.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    const content = contentRef.current
    if (!anchor || !content) return
    zoomAnchor.current = null
    const ratio = zoom / anchor.prev
    const rect = content.getBoundingClientRect()
    const docList = content.querySelector<HTMLElement>('.doc-list')

    // Vertical: pin the hovered strip's cursor offset (page heights scale by
    // exactly `ratio`; headers above don't move within the row).
    if (docList) {
      if (anchor.strip?.isConnected) {
        const stripTop = anchor.strip.getBoundingClientRect().top
        const desiredTop = anchor.y - anchor.stripOffsetY * ratio
        shiftAxis(content, docList, 'y', desiredTop - stripTop)
      } else {
        const yRel = anchor.y - rect.top
        const offset = contentOffset(content, docList, 'y')
        shiftAxis(content, docList, 'y', (offset - yRel) * (ratio - 1))
      }
    }

    // Horizontal
    const xRel = anchor.x - rect.left
    content.querySelectorAll<HTMLElement>('.page-strip').forEach((strip) => {
      const inner = strip.firstElementChild as HTMLElement | null
      if (!inner) return
      if (strip === anchor.strip && anchor.page?.isConnected) {
        const pageRect = anchor.page.getBoundingClientRect()
        const target = pageRect.left + anchor.pageFrac * pageRect.width
        shiftAxis(strip, inner, 'x', anchor.x - target)
      } else {
        const offset = contentOffset(strip, inner, 'x')
        shiftAxis(strip, inner, 'x', (offset - xRel) * (ratio - 1))
      }
    })
  }, [zoom])

  // Pinch on trackpads (and ctrl/cmd + wheel) arrives as ctrlKey wheel events.
  // Shift + wheel zooms too, for mice without a trackpad.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return
      event.preventDefault()
      // With shift held, Chromium reports the wheel delta as deltaX.
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX
      const factor = Math.exp(-delta * 0.0112)
      applyZoom(zoomRef.current * factor, { x: event.clientX, y: event.clientY })
    }
    content.addEventListener('wheel', onWheel, { passive: false })
    return () => content.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  // Native menu accelerators (Cmd/Ctrl +, -, 0)
  useEffect(() => {
    return window.api.onZoom((action) => {
      if (action === 'in') applyZoom(zoomRef.current * ZOOM_STEP)
      else if (action === 'out') applyZoom(zoomRef.current / ZOOM_STEP)
      else applyZoom(1)
    })
  }, [applyZoom])

  const addFiles = useCallback(
    async (files: IncomingFile[]) => {
      if (files.length === 0) return
      setBusy(true)
      const failed: string[] = []
      for (const file of files) {
        try {
          // Images become single-page documents at their natural dimensions.
          const isImage = isImageFile(file.name) || isImageBytes(file.data)
          const name = isImage ? stripImageExtension(file.name) : file.name
          const data = isImage ? await imageToPdf(file.data) : file.data
          const entries = await importIntoDocs(name, data)
          setDocs((prev) => [...prev, ...entries])
        } catch (error) {
          console.error(`Failed to import ${file.name}`, error)
          failed.push(file.name)
        }
      }
      setBusy(false)
      if (failed.length > 0) flash(`Could not open ${failed.join(', ')}`)
    },
    [flash]
  )

  // Files opened via Finder / Explorer file association
  useEffect(() => {
    const unsubscribe = window.api.onFilesOpened((files) => void addFiles(files))
    void window.api.rendererReady()
    return unsubscribe
  }, [addFiles])

  const openViaDialog = useCallback(async () => {
    const files = await window.api.openFiles()
    await addFiles(files)
  }, [addFiles])

  // "Single PDF" is the same container as .pdfx (manifest included, so it
  // re-imports as separate documents) — only the extension differs.
  const exportCollection = useCallback(
    async (kind: 'pdfx' | 'pdf') => {
      if (docs.length === 0) {
        flash('Nothing to export')
        return
      }
      const filter =
        kind === 'pdfx'
          ? { name: 'PDFX', extensions: ['pdfx'] }
          : { name: 'PDF', extensions: ['pdf'] }
      const path = await window.api.chooseSavePath(`untitled.${kind}`, filter)
      if (!path) return
      setBusy(true)
      try {
        const filename = path.split(/[\\/]/).pop() ?? `untitled.${kind}`
        const bytes = await buildPdfx(
          docs.map((doc) => ({ name: doc.name, pages: doc.pages.map(toExportPage) })),
          stripExtension(filename).replace(/\.pdf$/i, '')
        )
        const saved = await window.api.writeFile(path, bytes)
        flash(`Saved ${saved}`)
      } catch (error) {
        console.error('Export failed', error)
        flash('Export failed')
      } finally {
        setBusy(false)
      }
    },
    [docs, flash]
  )

  // One plain .pdf per document, zipped, numbered to preserve order.
  const exportZip = useCallback(async () => {
    if (docs.length === 0) {
      flash('Nothing to export')
      return
    }
    const path = await window.api.chooseSavePath('untitled.zip', {
      name: 'ZIP',
      extensions: ['zip']
    })
    if (!path) return
    setBusy(true)
    try {
      const entries: Record<string, Uint8Array> = {}
      for (const [index, doc] of docs.entries()) {
        const safeName = doc.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled'
        const prefix = String(index + 1).padStart(2, '0')
        entries[`${prefix} - ${safeName}.pdf`] = await buildPdf(doc.pages.map(toExportPage))
      }
      const saved = await window.api.writeFile(path, zipSync(entries))
      flash(`Saved ${saved}`)
    } catch (error) {
      console.error('Export failed', error)
      flash('Export failed')
    } finally {
      setBusy(false)
    }
  }, [docs, flash])

  const removeDoc = useCallback((id: string) => {
    setDocs((prev) => prev.filter((d) => d.id !== id))
    setSelected((sel) => (sel?.docId === id ? null : sel))
  }, [])

  const moveDoc = useCallback((id: string, direction: -1 | 1) => {
    setDocs((prev) => {
      const index = prev.findIndex((d) => d.id === id)
      const target = index + direction
      if (index === -1 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [])

  // ---------- Page operations ----------

  const deletePage = useCallback(
    (target: PageRef) => {
      const doc = docs.find((d) => d.id === target.docId)
      const index = doc?.pages.findIndex((p) => p.id === target.pageId) ?? -1
      if (!doc || index === -1) return
      const pages = doc.pages.filter((p) => p.id !== target.pageId)
      const neighbor = pages[Math.min(index, pages.length - 1)]
      setDocs((prev) =>
        prev.map((d) => (d.id === doc.id ? { ...d, pages } : d)).filter((d) => d.pages.length > 0)
      )
      setSelected(neighbor ? { docId: doc.id, pageId: neighbor.id } : null)
    },
    [docs]
  )

  const copySelected = useCallback(() => {
    if (!selected) return
    const page = docs
      .find((d) => d.id === selected.docId)
      ?.pages.find((p) => p.id === selected.pageId)
    if (!page) return
    clipboardRef.current = page
    // Claim the clipboard so a stale system image doesn't shadow this copy on ⌘V.
    void window.api.clearClipboard()
    flash('Page copied — ⌘V pastes it after the selected page')
  }, [docs, selected, flash])

  const pasteAfterSelected = useCallback(() => {
    const clip = clipboardRef.current
    if (!clip || !selected) return
    const pasted: PageEntry = { ...clip, id: crypto.randomUUID() }
    setDocs((prev) =>
      prev.map((doc) => {
        if (doc.id !== selected.docId) return doc
        const index = doc.pages.findIndex((p) => p.id === selected.pageId)
        if (index === -1) return doc
        const pages = [...doc.pages]
        pages.splice(index + 1, 0, pasted)
        return { ...doc, pages }
      })
    )
    setSelected({ docId: selected.docId, pageId: pasted.id })
  }, [selected])

  // The selected page, if any — pastes insert right after it.
  const selectedTarget = useCallback((): { doc: DocEntry; index: number } | null => {
    if (!selected) return null
    const doc = docs.find((d) => d.id === selected.docId)
    const index = doc?.pages.findIndex((p) => p.id === selected.pageId) ?? -1
    return doc && index !== -1 ? { doc, index } : null
  }, [docs, selected])

  const insertPagesAfter = useCallback(
    (target: { doc: DocEntry; index: number }, entries: PageEntry[]) => {
      if (entries.length === 0) return
      setDocs((prev) =>
        prev.map((d) =>
          d.id === target.doc.id
            ? {
                ...d,
                pages: [
                  ...d.pages.slice(0, target.index + 1),
                  ...entries,
                  ...d.pages.slice(target.index + 1)
                ]
              }
            : d
        )
      )
      setSelected({ docId: target.doc.id, pageId: entries[entries.length - 1].id })
    },
    []
  )

  // Paste files copied in Finder/Explorer. With a page selected, their pages
  // are inserted right after it (images sized like the selected page);
  // without a selection they import as new documents, same as dropping.
  const pasteFiles = useCallback(
    async (files: IncomingFile[]) => {
      const target = selectedTarget()
      if (!target) {
        await addFiles(files)
        return
      }
      setBusy(true)
      try {
        const reference = target.doc.pages[target.index]
        const entries: PageEntry[] = []
        for (const file of files) {
          const isImage = isImageFile(file.name) || isImageBytes(file.data)
          const bytes = isImage
            ? await imageToPdf(file.data, { width: reference.width, height: reference.height })
            : file.data
          const { source, sizes } = await loadSource(bytes)
          entries.push(
            ...pagesFromSource(
              source,
              sizes,
              sizes.map((_, i) => i)
            )
          )
        }
        insertPagesAfter(target, entries)
      } catch (error) {
        console.error('Paste failed', error)
        flash('Could not paste')
      } finally {
        setBusy(false)
      }
    },
    [selectedTarget, addFiles, insertPagesAfter, flash]
  )

  // Paste raw image data (screenshots, copied images). With a page selected,
  // the image becomes a new page right after it, sized like that page (image
  // fit inside, centered) for consistency. Otherwise it becomes a new document.
  const pasteImage = useCallback(
    async (png: Uint8Array) => {
      try {
        const target = selectedTarget()
        if (target) {
          const reference = target.doc.pages[target.index]
          const bytes = await imageToPdf(png, { width: reference.width, height: reference.height })
          const { source, sizes } = await loadSource(bytes)
          insertPagesAfter(target, pagesFromSource(source, sizes, [0]))
        } else {
          const entries = await importIntoDocs('Pasted image', await imageToPdf(png))
          setDocs((prev) => [...prev, ...entries])
        }
      } catch (error) {
        console.error('Image paste failed', error)
        flash('Could not paste image')
      }
    },
    [selectedTarget, insertPagesAfter, flash]
  )

  const handlePaste = useCallback(async () => {
    // Order matters: a file copied in Finder/Explorer also puts a preview
    // icon on the clipboard — readImage() alone would paste that icon.
    const files = await window.api.readClipboardFiles()
    if (files.length > 0) {
      await pasteFiles(files)
      return
    }
    const png = await window.api.readClipboardImage()
    if (png && png.length > 0) {
      await pasteImage(png)
      return
    }
    pasteAfterSelected()
  }, [pasteFiles, pasteImage, pasteAfterSelected])

  // Live reorder while dragging within a document: place the dragged page at
  // `insertAt` (an index among the other pages). No-ops return `prev` so the
  // 60Hz dragover stream causes zero re-renders while the order is stable.
  const movePageToIndex = useCallback((docId: string, dragId: string, insertAt: number) => {
    setDocs((prev) => {
      const docIndex = prev.findIndex((d) => d.id === docId)
      if (docIndex === -1) return prev
      const doc = prev[docIndex]
      const from = doc.pages.findIndex((p) => p.id === dragId)
      if (from === -1) return prev
      const without = doc.pages.filter((p) => p.id !== dragId)
      const clamped = Math.max(0, Math.min(without.length, insertAt))
      const pages = [...without.slice(0, clamped), doc.pages[from], ...without.slice(clamped)]
      if (pages.every((p, i) => p === doc.pages[i])) return prev
      const next = [...prev]
      next[docIndex] = { ...doc, pages }
      return next
    })
  }, [])

  // Move a page into another document (cross-document drop). Committed on
  // drop, not live: live-moving would unmount the drag-source element, which
  // breaks Chromium's dragend event and strands the drag state.
  const movePageAcross = useCallback((source: PageRef, targetDocId: string, insertAt: number) => {
    if (source.docId === targetDocId) return
    setDocs((prev) => {
      const page = prev
        .find((d) => d.id === source.docId)
        ?.pages.find((p) => p.id === source.pageId)
      if (!page) return prev
      return prev
        .map((d) => {
          if (d.id === source.docId) {
            return { ...d, pages: d.pages.filter((p) => p.id !== source.pageId) }
          }
          if (d.id === targetDocId) {
            const clamped = Math.max(0, Math.min(d.pages.length, insertAt))
            return { ...d, pages: [...d.pages.slice(0, clamped), page, ...d.pages.slice(clamped)] }
          }
          return d
        })
        .filter((d) => d.pages.length > 0)
    })
    setSelected({ docId: targetDocId, pageId: source.pageId })
  }, [])

  const updateDropHint = useCallback((docId: string, index: number | null) => {
    setDropHint((prev) => {
      if (index === null) return prev?.docId === docId ? null : prev
      if (prev && prev.docId === docId && prev.index === index) return prev
      return { docId, index }
    })
  }, [])

  const endPageDrag = useCallback(() => {
    setDraggingPage(null)
    setDropHint(null)
  }, [])

  // ---------- Keyboard ----------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (fullView) return // FullView handles its own keys
      const mod = event.metaKey || event.ctrlKey
      if ((event.key === 'Backspace' || event.key === 'Delete') && selected) {
        event.preventDefault()
        deletePage(selected)
      } else if (mod && event.key.toLowerCase() === 'c' && selected) {
        copySelected()
      } else if (mod && event.key.toLowerCase() === 'v') {
        void handlePaste()
      } else if (event.key === 'Escape') {
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullView, selected, deletePage, copySelected, handlePaste])

  // File menu actions
  useEffect(() => {
    return window.api.onMenu((action) => {
      if (action === 'open') void openViaDialog()
      else if (action === 'export-pdfx') void exportCollection('pdfx')
      else if (action === 'export-pdf') void exportCollection('pdf')
      else if (action === 'export-zip') void exportZip()
    })
  }, [openViaDialog, exportCollection, exportZip])

  // ---------- File drag & drop (internal page drags are filtered out) ----------

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (!event.dataTransfer.types.includes('Files')) return
      const dropped = Array.from(event.dataTransfer.files).filter(
        (f) => /\.(pdf|pdfx)$/i.test(f.name) || isImageFile(f.name) || f.type.startsWith('image/')
      )
      const files = await Promise.all(
        dropped.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))
      )
      await addFiles(files)
    },
    [addFiles]
  )

  const totalPages = docs.reduce((sum, d) => sum + d.pages.length, 0)
  const pageHeight = Math.max(8, Math.round(BASE_PAGE_HEIGHT * zoom))
  const fullViewDoc = fullView ? docs.find((d) => d.id === fullView.docId) : undefined
  const draggedEntry = draggingPage
    ? docs.find((d) => d.id === draggingPage.docId)?.pages.find((p) => p.id === draggingPage.pageId)
    : undefined
  const dropHintWidth = draggedEntry
    ? Math.max(6, Math.round((pageHeight * draggedEntry.width) / draggedEntry.height))
    : 0

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault()
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <Toolbar
        documentCount={docs.length}
        pageCount={totalPages}
        busy={busy}
        zoom={zoom}
        onZoomIn={() => applyZoom(zoomRef.current * ZOOM_STEP)}
        onZoomOut={() => applyZoom(zoomRef.current / ZOOM_STEP)}
        onZoomReset={() => applyZoom(1)}
        onOpen={openViaDialog}
        onExport={() => exportCollection('pdfx')}
      />

      <main
        className="content"
        ref={contentRef}
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (!target.closest('.page') && !target.closest('button')) setSelected(null)
        }}
      >
        {docs.length === 0 ? (
          <EmptyState busy={busy} onOpen={openViaDialog} />
        ) : (
          <div className={zoom < COMPACT_ZOOM ? 'doc-list compact' : 'doc-list'}>
            {docs.map((doc, index) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                index={index}
                total={docs.length}
                pageHeight={pageHeight}
                selectedPageId={selected?.docId === doc.id ? selected.pageId : null}
                draggingPageId={draggingPage?.docId === doc.id ? draggingPage.pageId : null}
                foreignDragActive={draggingPage !== null && draggingPage.docId !== doc.id}
                dropHintIndex={dropHint?.docId === doc.id ? dropHint.index : null}
                dropHintWidth={dropHintWidth}
                onRemove={() => removeDoc(doc.id)}
                onMove={(direction) => moveDoc(doc.id, direction)}
                onSelectPage={(pageId) => setSelected({ docId: doc.id, pageId })}
                onOpenPage={(pageId) => setFullView({ docId: doc.id, pageId })}
                onPageDragStart={(pageId) => setDraggingPage({ docId: doc.id, pageId })}
                onPageDragEnd={endPageDrag}
                onPageDragTo={(insertAt) => {
                  if (draggingPage?.docId === doc.id) {
                    movePageToIndex(doc.id, draggingPage.pageId, insertAt)
                  }
                }}
                onForeignDragOver={(insertAt) => updateDropHint(doc.id, insertAt)}
                onForeignDrop={(insertAt) => {
                  if (draggingPage) {
                    movePageAcross(draggingPage, doc.id, insertAt)
                    endPageDrag()
                  }
                }}
              />
            ))}
            <button className="add-row" onClick={openViaDialog} disabled={busy}>
              + Add documents
            </button>
          </div>
        )}
      </main>

      {fullView && fullViewDoc && (
        <FullView
          doc={fullViewDoc}
          startPageId={fullView.pageId}
          onClose={() => setFullView(null)}
        />
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">Drop to add</div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
