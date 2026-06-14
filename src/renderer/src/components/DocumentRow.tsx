import { useLayoutEffect, useRef } from 'react'
import type { DocEntry } from '../types'
import { PageCanvas } from './PageCanvas'

interface DocumentRowProps {
  doc: DocEntry
  index: number
  total: number
  pageHeight: number
  selectedPageId: string | null
  /** Page being dragged, when the drag started in THIS document. */
  draggingPageId: string | null
  /** True when a page from ANOTHER document is being dragged. */
  foreignDragActive: boolean
  /** Insertion index for the foreign-drag gap, or null. */
  dropHintIndex: number | null
  /** Display width of the dragged page, used to size the gap. */
  dropHintWidth: number
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
  onSelectPage: (pageId: string) => void
  onOpenPage: (pageId: string) => void
  onPageDragStart: (pageId: string) => void
  onPageDragEnd: () => void
  /** Live within-document reorder: place dragged page at this index. */
  onPageDragTo: (insertAt: number) => void
  /** Foreign drag hovering at this index (null = left the strip). */
  onForeignDragOver: (insertAt: number | null) => void
  /** Foreign page dropped at this index. */
  onForeignDrop: (insertAt: number) => void
}

export function DocumentRow({
  doc,
  index,
  total,
  pageHeight,
  selectedPageId,
  draggingPageId,
  foreignDragActive,
  dropHintIndex,
  dropHintWidth,
  onRemove,
  onMove,
  onSelectPage,
  onOpenPage,
  onPageDragStart,
  onPageDragEnd,
  onPageDragTo,
  onForeignDragOver,
  onForeignDrop
}: DocumentRowProps): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const flipRects = useRef<Map<string, number> | null>(null)

  // Insertion index from the cursor's X position against page midpoints.
  // Coordinate-based, so gaps and padding between pages are never dead zones
  // (hovering them used to teleport the page to the end — flicker city).
  const insertionIndexFromX = (clientX: number, excludeId: string | null): number => {
    const strip = stripRef.current
    if (!strip) return 0
    let insertAt = 0
    for (const el of strip.querySelectorAll<HTMLElement>('[data-page-id]')) {
      if (el.dataset.pageId === excludeId) continue
      const rect = el.getBoundingClientRect()
      if (clientX <= rect.left + rect.width / 2) break
      insertAt++
    }
    return insertAt
  }

  // FLIP: while a page is being dragged, animate the others sliding into
  // their new positions whenever the live order changes.
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    if (!draggingPageId) {
      flipRects.current = null
      return
    }
    const previous = flipRects.current
    const next = new Map<string, number>()
    strip.querySelectorAll<HTMLElement>('[data-page-id]').forEach((el) => {
      next.set(el.dataset.pageId!, el.getBoundingClientRect().left)
    })
    if (previous) {
      next.forEach((left, id) => {
        const old = previous.get(id)
        if (old === undefined || Math.abs(old - left) < 1) return
        strip
          .querySelector<HTMLElement>(`[data-page-id="${CSS.escape(id)}"]`)
          ?.animate(
            [{ transform: `translateX(${old - left}px)` }, { transform: 'translateX(0)' }],
            {
              duration: 180,
              easing: 'cubic-bezier(0.2, 0, 0, 1)'
            }
          )
      })
    }
    flipRects.current = next
  })

  return (
    <section className="doc-row">
      <header className="doc-header">
        <span className="doc-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="doc-name" title={doc.name}>
          {doc.name}
        </span>
        <span className="doc-pages">
          {doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'}
        </span>
        <div className="doc-actions">
          <button
            className="icon-btn"
            title="Move up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Move down"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <button className="icon-btn" title="Remove document" onClick={onRemove}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </header>
      <div
        className="page-strip"
        ref={stripRef}
        onDragOver={(e) => {
          // One handler for the whole strip (events bubble up from pages).
          if (draggingPageId) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            onPageDragTo(insertionIndexFromX(e.clientX, draggingPageId))
          } else if (foreignDragActive) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            onForeignDragOver(insertionIndexFromX(e.clientX, null))
          }
        }}
        onDragLeave={(e) => {
          if (foreignDragActive && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
            onForeignDragOver(null)
          }
        }}
        onDrop={(e) => {
          if (draggingPageId) {
            e.preventDefault()
          } else if (foreignDragActive) {
            e.preventDefault()
            onForeignDrop(insertionIndexFromX(e.clientX, null))
          }
        }}
      >
        <div className="page-strip-inner">
          {doc.pages.map((page, pageIndex) => (
            <div
              key={page.id}
              data-page-id={page.id}
              className={
                'page' +
                (page.id === selectedPageId ? ' selected' : '') +
                (page.id === draggingPageId ? ' dragging' : '')
              }
              style={{
                width: Math.max(6, Math.round((pageHeight * page.width) / page.height)),
                height: pageHeight,
                marginLeft:
                  dropHintIndex !== null && pageIndex === dropHintIndex
                    ? dropHintWidth + 18
                    : undefined,
                marginRight:
                  dropHintIndex !== null &&
                  dropHintIndex === doc.pages.length &&
                  pageIndex === doc.pages.length - 1
                    ? dropHintWidth + 18
                    : undefined
              }}
              draggable
              onClick={(e) => {
                e.stopPropagation()
                onSelectPage(page.id)
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onOpenPage(page.id)
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-pdfx-page', page.id)
                e.dataTransfer.effectAllowed = 'move'
                onPageDragStart(page.id)
              }}
              onDragEnd={onPageDragEnd}
            >
              <PageCanvas
                pdf={page.source.pdf}
                pageNumber={page.pageIndex + 1}
                height={pageHeight}
              />
              <span className="page-number">{pageIndex + 1}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
