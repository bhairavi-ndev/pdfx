import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DocEntry } from '../types'
import { PageCanvas } from './PageCanvas'

interface FullViewProps {
  doc: DocEntry
  startPageId: string
  onClose: () => void
}

const isMac = window.api.platform === 'darwin'

export function FullView({ doc, startPageId, onClose }: FullViewProps): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const wheelLock = useRef(0)
  const [current, setCurrent] = useState(() =>
    Math.max(
      0,
      doc.pages.findIndex((p) => p.id === startPageId)
    )
  )
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })

  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Open on the double-clicked page, and hold position through resizes.
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (strip) strip.scrollLeft = current * strip.clientWidth
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount/resize
  }, [viewport])

  const goTo = useCallback(
    (index: number) => {
      const strip = stripRef.current
      if (!strip) return
      const clamped = Math.max(0, Math.min(doc.pages.length - 1, index))
      strip.scrollTo({ left: clamped * strip.clientWidth, behavior: 'smooth' })
    },
    [doc.pages.length]
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight') goTo(current + 1)
      else if (event.key === 'ArrowLeft') goTo(current - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, goTo, onClose])

  // Vertical mouse wheel flips one page at a time; horizontal swipes use
  // native scrolling, where snap points settle on a page.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) return
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      const now = Date.now()
      if (now - wheelLock.current < 250) return
      wheelLock.current = now
      goTo(Math.round(strip.scrollLeft / strip.clientWidth) + (event.deltaY > 0 ? 1 : -1))
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [goTo])

  const onScroll = (): void => {
    const strip = stripRef.current
    if (!strip) return
    setCurrent(
      Math.max(0, Math.min(doc.pages.length - 1, Math.round(strip.scrollLeft / strip.clientWidth)))
    )
  }

  const availW = viewport.w - 120
  const availH = viewport.h - 120

  return (
    <div className="full-view">
      <header className={`full-bar${isMac ? ' mac' : ''}`}>
        <span className="full-title">{doc.name}</span>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </header>

      <div className="full-strip" ref={stripRef} onScroll={onScroll}>
        {doc.pages.map((page) => {
          const scale = Math.min(availH / page.height, availW / page.width)
          const width = Math.max(1, Math.round(page.width * scale))
          const height = Math.max(1, Math.round(page.height * scale))
          return (
            <div
              key={page.id}
              className="full-slide"
              onClick={(e) => {
                if (e.target === e.currentTarget) onClose()
              }}
            >
              <div className="full-page" style={{ width, height }} onDoubleClick={onClose}>
                <PageCanvas pdf={page.source.pdf} pageNumber={page.pageIndex + 1} height={height} />
              </div>
            </div>
          )
        })}
      </div>

      <button
        className="full-nav prev"
        disabled={current === 0}
        onClick={() => goTo(current - 1)}
        title="Previous page (←)"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <button
        className="full-nav next"
        disabled={current === doc.pages.length - 1}
        onClick={() => goTo(current + 1)}
        title="Next page (→)"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      <div className="full-count">
        {current + 1} / {doc.pages.length}
      </div>
    </div>
  )
}
