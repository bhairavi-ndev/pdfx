import { PDFDocument } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * PDFX format, v1.0
 *
 * A .pdfx file is a fully valid PDF: the pages of every document are merged
 * sequentially, so any standard PDF viewer opens it as-is. What makes it a
 * PDFX collection is a JSON manifest embedded as a standard PDF file
 * attachment (PDF 32000-1:2008 §7.11.4) named `pdfx-manifest.json`:
 *
 *   {
 *     "pdfx": "1.0",
 *     "title": "Q1 Invoices",
 *     "documents": [
 *       { "name": "Invoice March", "pages": 3 },
 *       { "name": "Contract", "pages": 12 }
 *     ]
 *   }
 *
 * Page counts partition the merged page sequence in order. A PDF without a
 * manifest is simply a single-document collection.
 */

export const MANIFEST_NAME = 'pdfx-manifest.json'
export const PDFX_VERSION = '1.0'

export interface PdfxManifestDocument {
  name: string
  pages: number
}

export interface PdfxManifest {
  pdfx: string
  title?: string
  documents: PdfxManifestDocument[]
}

/** A run of pages belonging to one logical document. */
export interface PagePartition {
  name: string
  /** 0-based page indices into the container PDF. */
  indices: number[]
}

/** One page of a document to export, referencing its source PDF. */
export interface ExportPage {
  /** Bytes of the source PDF this page comes from. */
  bytes: Uint8Array
  /** Stable key identifying the source, so loads can be cached. */
  sourceKey: string
  /** 0-based page index within the source. */
  pageIndex: number
}

export interface ExportDocument {
  name: string
  pages: ExportPage[]
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i)
}

export function stripExtension(filename: string): string {
  return filename.replace(/\.(pdf|pdfx)$/i, '')
}

/** Read the PDFX manifest from a loaded pdf.js document, or null if absent/invalid. */
export async function readManifest(pdf: PDFDocumentProxy): Promise<PdfxManifest | null> {
  const attachments = (await pdf.getAttachments()) as Record<
    string,
    { filename?: string; content: Uint8Array }
  > | null
  if (!attachments) return null

  for (const [key, attachment] of Object.entries(attachments)) {
    if ((attachment.filename ?? key) !== MANIFEST_NAME) continue
    try {
      const manifest = JSON.parse(new TextDecoder().decode(attachment.content)) as PdfxManifest
      const valid =
        manifest &&
        Array.isArray(manifest.documents) &&
        manifest.documents.every(
          (d) => typeof d.name === 'string' && Number.isInteger(d.pages) && d.pages > 0
        )
      return valid ? manifest : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Partition a container PDF's pages into logical documents. No manifest means
 * a single document — plain PDFs are unaffected. Lenient reading: pages
 * beyond the manifest become one trailing document.
 */
export function partitionPages(
  manifest: PdfxManifest | null,
  totalPages: number,
  fallbackName: string
): PagePartition[] {
  if (!manifest) return [{ name: fallbackName, indices: range(0, totalPages) }]

  const partitions: PagePartition[] = []
  let cursor = 0
  for (const entry of manifest.documents) {
    const count = Math.min(entry.pages, totalPages - cursor)
    if (count <= 0) break
    partitions.push({ name: entry.name, indices: range(cursor, count) })
    cursor += count
  }
  if (cursor < totalPages) {
    partitions.push({ name: 'Untitled', indices: range(cursor, totalPages - cursor) })
  }
  return partitions
}

/** Build a plain single-document PDF (no manifest) from page references. */
export async function buildPdf(pages: ExportPage[]): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const sources = new Map<string, PDFDocument>()
  for (const page of pages) {
    let source = sources.get(page.sourceKey)
    if (!source) {
      source = await PDFDocument.load(page.bytes, { ignoreEncryption: true })
      sources.set(page.sourceKey, source)
    }
    const [copied] = await output.copyPages(source, [page.pageIndex])
    output.addPage(copied)
  }
  output.setProducer(`PDFX ${PDFX_VERSION}`)
  return output.save()
}

/** Merge documents into a single PDFX container: a valid PDF plus the manifest attachment. */
export async function buildPdfx(documents: ExportDocument[], title: string): Promise<Uint8Array> {
  const output = await PDFDocument.create()
  const manifest: PdfxManifest = { pdfx: PDFX_VERSION, title, documents: [] }
  const sources = new Map<string, PDFDocument>()

  for (const doc of documents) {
    if (doc.pages.length === 0) continue
    for (const page of doc.pages) {
      let source = sources.get(page.sourceKey)
      if (!source) {
        source = await PDFDocument.load(page.bytes, { ignoreEncryption: true })
        sources.set(page.sourceKey, source)
      }
      const [copied] = await output.copyPages(source, [page.pageIndex])
      output.addPage(copied)
    }
    manifest.documents.push({ name: doc.name, pages: doc.pages.length })
  }

  await output.attach(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), MANIFEST_NAME, {
    mimeType: 'application/json',
    description: 'PDFX manifest describing the documents in this collection',
    creationDate: new Date(),
    modificationDate: new Date()
  })

  output.setTitle(title)
  output.setProducer(`PDFX ${PDFX_VERSION}`)
  output.setKeywords(['PDFX'])

  return output.save()
}
