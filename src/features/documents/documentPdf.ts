import type { S4Document } from './documentModels'
import { renderS4PrintableHtml } from './documentTemplates'

export type S4PdfFactory = (document: S4Document) => Promise<Blob>

export async function createS4PdfBlob(document: S4Document): Promise<Blob> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
  const host = documentObject().createElement('div')
  host.className = 'pdf-render-host'
  host.innerHTML = renderS4PrintableHtml(document)
  documentObject().body.append(host)
  try {
    const canvas = await html2canvas(host, { scale: 2, backgroundColor: '#ffffff', logging: false })
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
    const width = 190
    const pagePixelHeight = Math.floor(canvas.width * 277 / width)
    for (let offset = 0, page = 0; offset < canvas.height; offset += pagePixelHeight, page += 1) {
      const sliceHeight = Math.min(pagePixelHeight, canvas.height - offset)
      const slice = documentObject().createElement('canvas')
      slice.width = canvas.width; slice.height = sliceHeight
      slice.getContext('2d')?.drawImage(canvas, 0, offset, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)
      if (page > 0) pdf.addPage()
      pdf.addImage(slice.toDataURL('image/png'), 'PNG', 10, 10, width, sliceHeight * width / canvas.width)
    }
    return pdf.output('blob')
  } finally { host.remove() }
}

export async function createS4Zip(documents: S4Document[], pdfFactory: S4PdfFactory = createS4PdfBlob): Promise<Blob> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  for (const document of documents) {
    const safeAlias = document.studentAlias.replaceAll(/[^0-9A-Za-z가-힣_-]/g, '_')
    zip.file(`${document.period}_S4_${safeAlias}.pdf`, await pdfFactory(document))
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip' })
}

export async function downloadS4Pdf(document: S4Document): Promise<void> {
  downloadBlob(await createS4PdfBlob(document), `${document.period}_S4_${document.studentAlias}.pdf`)
}

export async function downloadS4Zip(documents: S4Document[]): Promise<void> {
  if (documents.length === 0) throw new Error('일괄 다운로드할 S4 문서가 없습니다.')
  downloadBlob(await createS4Zip(documents), `${documents[0]!.period}_S4_개별안내문.zip`)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = documentObject().createElement('a')
  link.href = url; link.download = filename; link.click()
  URL.revokeObjectURL(url)
}

function documentObject(): Document {
  if (typeof document === 'undefined') throw new Error('PDF 생성은 브라우저에서만 사용할 수 있습니다.')
  return document
}
