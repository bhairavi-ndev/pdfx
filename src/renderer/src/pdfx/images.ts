import { PDFDocument } from 'pdf-lib'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

export function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name)
}

export function stripImageExtension(name: string): string {
  return name.replace(IMAGE_EXT, '')
}

function isPng(data: Uint8Array): boolean {
  return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
}

function isJpeg(data: Uint8Array): boolean {
  return data[0] === 0xff && data[1] === 0xd8
}

/** Sniff PNG/JPEG by magic bytes, for files without a telling extension. */
export function isImageBytes(data: Uint8Array): boolean {
  return isPng(data) || isJpeg(data)
}

// Copy into a fresh ArrayBuffer-backed array: Uint8Array<ArrayBufferLike>
// (e.g. straight off IPC) isn't assignable to BlobPart under TS 5.8.
function toBlob(data: Uint8Array): Blob {
  return new Blob([new Uint8Array(data)])
}

async function rasterToPng(bitmap: ImageBitmap): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG encoding failed')
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Wrap an image in a one-page PDF. PNG/JPEG bytes embed as-is; everything
 * else the browser can decode (webp, gif, …) is rasterized to PNG first.
 *
 * Without `pageSize` the page takes the image's natural dimensions (1px =
 * 1pt). With `pageSize` the image is fit-contain, centered — used when
 * pasting into an existing document to match the neighboring page.
 */
export async function imageToPdf(
  data: Uint8Array,
  pageSize?: { width: number; height: number }
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  let image
  if (isPng(data)) {
    image = await doc.embedPng(data)
  } else if (isJpeg(data)) {
    // pdf-lib ignores EXIF orientation; if the browser's oriented decode has
    // different dimensions, the JPEG is rotated — rasterize it instead.
    const oriented = await createImageBitmap(toBlob(data))
    const raw = await createImageBitmap(toBlob(data), { imageOrientation: 'none' })
    const rotated = oriented.width !== raw.width
    raw.close()
    image = rotated ? await doc.embedPng(await rasterToPng(oriented)) : await doc.embedJpg(data)
    oriented.close()
  } else {
    const bitmap = await createImageBitmap(toBlob(data))
    image = await doc.embedPng(await rasterToPng(bitmap))
    bitmap.close()
  }

  const pageWidth = pageSize?.width ?? image.width
  const pageHeight = pageSize?.height ?? image.height
  const scale = Math.min(pageWidth / image.width, pageHeight / image.height)
  const width = image.width * scale
  const height = image.height * scale

  const page = doc.addPage([pageWidth, pageHeight])
  page.drawImage(image, {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height
  })
  return doc.save()
}
