import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'

// Cap raster dimensions so deep zoom on large pages can't allocate huge canvases.
const MAX_RASTER = 3000

interface PageCanvasProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  /** Display height the raster should target; the canvas itself fills its parent. */
  height: number
}

export function PageCanvas({ pdf, pageNumber, height }: PageCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [rendered, setRendered] = useState(false)
  // During a zoom gesture the canvas just CSS-stretches to its container;
  // once the size settles for a beat we re-rasterize at the new resolution.
  const [rasterHeight, setRasterHeight] = useState(height)

  useEffect(() => {
    if (rasterHeight === height) return
    const timer = setTimeout(() => setRasterHeight(height), 160)
    return () => clearTimeout(timer)
  }, [height, rasterHeight])

  // Lazy rendering: only rasterize pages near the viewport.
  useEffect(() => {
    const element = canvasRef.current
    if (!element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: RenderTask | null = null

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(
          (rasterHeight / baseViewport.height) * dpr,
          MAX_RASTER / baseViewport.height,
          MAX_RASTER / baseViewport.width
        )
        const viewport = page.getViewport({ scale })

        // Render to an offscreen canvas, then blit — avoids pdf.js's
        // "same canvas in multiple render() calls" error under re-renders.
        const offscreen = document.createElement('canvas')
        offscreen.width = Math.max(1, Math.floor(viewport.width))
        offscreen.height = Math.max(1, Math.floor(viewport.height))
        task = page.render({ canvas: offscreen, viewport })
        await task.promise
        if (cancelled) return

        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = offscreen.width
        canvas.height = offscreen.height
        canvas.getContext('2d')!.drawImage(offscreen, 0, 0)
        setRendered(true)
      } catch (error) {
        if ((error as Error)?.name !== 'RenderingCancelledException') {
          console.error(`Failed to render page ${pageNumber}`, error)
        }
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [visible, pdf, pageNumber, rasterHeight])

  return <canvas ref={canvasRef} className={rendered ? 'page-canvas visible' : 'page-canvas'} />
}
