import type { PDFDocumentProxy } from 'pdfjs-dist'

/** A loaded PDF file. Pages reference sources; sources live for the session. */
export interface PdfSource {
  id: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
}

/** One page of a document — an editable reference into a source PDF. */
export interface PageEntry {
  id: string
  source: PdfSource
  /** 0-based page index within the source. */
  pageIndex: number
  /** Page dimensions at scale 1, used to reserve layout before rendering. */
  width: number
  height: number
}

export interface DocEntry {
  id: string
  name: string
  pages: PageEntry[]
}
