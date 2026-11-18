/**
 * Plain text from a business document. Table cells are joined with " | " and each row is one line,
 * so PDF, Word, Excel and CSV reach the parsers in the same layout. Scanned PDF pages and photos
 * are read by OCR on this server (ocr.ts). The content is data, never instructions (rule 9).
 */
import ExcelJS from 'exceljs'
import sharp from 'sharp'
import { extractImages, getDocumentProxy } from 'unpdf'
import type { FileKind } from '../storage/sniff.js'
import { MAX_INPUT_PIXELS, OcrError, recognize } from './ocr.js'
import { openSafeZip, UnsafeArchive } from './zip-guard.js'

export interface ReadOptions {
  /** Read scanned pages and images with OCR (default true). */
  ocr?: boolean
  /** OCR at most this many pages of one PDF (default 10). */
  maxOcrPages?: number
}

export interface ReadResult {
  text: string
  pages: number | null
  ocrUsed: boolean
  /** Mean OCR confidence (0–100) over the pages read by OCR; null without OCR. */
  ocrConfidence: number | null
  /** Notes for the reviewer, e.g. pages skipped. */
  notes: string[]
}

/** A document that cannot be read: the message is safe to show to the user. */
export class UnreadableDocument extends Error {}

export const MAX_PDF_PAGES = 50
const MAX_TEXT_CHARS = 300_000
/** A page with fewer visible characters than this is treated as scanned. */
const SCANNED_PAGE_CHARS = 25

export async function extractText(bytes: Buffer, kind: FileKind, options: ReadOptions = {}): Promise<string> {
  return (await readDocument(bytes, kind, options)).text
}

export async function readDocument(bytes: Buffer, kind: FileKind, options: ReadOptions = {}): Promise<ReadResult> {
  const ocr = options.ocr ?? true
  const maxOcrPages = options.maxOcrPages ?? 10
  let result: ReadResult
  try {
    switch (kind) {
      case 'pdf': result = await pdfText(bytes, ocr, maxOcrPages); break
      case 'xlsx': result = plain(await xlsxText(bytes)); break
      case 'csv': result = plain(csvText(bytes)); break
      case 'docx': result = plain(await docxText(bytes)); break
      case 'txt': result = plain(bytes.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')); break
      case 'png': case 'jpeg': case 'webp': {
        if (!ocr) throw new UnreadableDocument("La lecture des images (OCR) est désactivée sur ce serveur.")
        const r = await recognize(bytes)
        result = { text: r.text, pages: 1, ocrUsed: true, ocrConfidence: r.confidence, notes: [] }
        break
      }
      default: throw new UnreadableDocument('Format non pris en charge.')
    }
  } catch (error) {
    if (error instanceof UnreadableDocument) throw error
    if (error instanceof UnsafeArchive || error instanceof OcrError) throw new UnreadableDocument(error.message)
    throw new UnreadableDocument('Fichier illisible ou endommagé.')
  }
  result.text = result.text.slice(0, MAX_TEXT_CHARS)
  return result
}

const plain = (text: string): ReadResult => ({ text, pages: null, ocrUsed: false, ocrConfidence: null, notes: [] })

interface Item { str: string; x: number; y: number; width: number }

async function pdfText(bytes: Buffer, ocr: boolean, maxOcrPages: number): Promise<ReadResult> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false })
  const lines: string[] = []
  const notes: string[] = []
  const pages = Math.min(pdf.numPages, MAX_PDF_PAGES)
  if (pdf.numPages > MAX_PDF_PAGES) notes.push(`Seules les ${MAX_PDF_PAGES} premières pages sur ${pdf.numPages} ont été lues.`)
  let ocrPages = 0
  const confidences: number[] = []
  try {
    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p)
      const content = await page.getTextContent()
      const items: Item[] = []
      for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
        if (!raw.str || !raw.transform || raw.str.trim() === '') continue
        items.push({ str: raw.str, x: raw.transform[4]!, y: raw.transform[5]!, width: raw.width ?? 0 })
      }
      const pageLines = layoutRows(items)
      const visible = pageLines.join('').replace(/\s/g, '').length
      if (visible < SCANNED_PAGE_CHARS && ocr) {
        if (ocrPages >= maxOcrPages) {
          if (ocrPages === maxOcrPages) notes.push(`Pages scannées lues par OCR : ${maxOcrPages} au maximum. Les suivantes sont ignorées.`)
          ocrPages++
          continue
        }
        // A scanned page is an image (or a few) inside the PDF: read those images, in page order.
        const images = (await extractImages(pdf, p)).filter(i => i.width >= 200 && i.height >= 200)
        if (images.length === 0) { notes.push(`Page ${p} : ni texte ni image lisible.`); continue }
        ocrPages++
        for (const image of images.slice(0, 4)) {
          if (image.width * image.height > MAX_INPUT_PIXELS) { notes.push(`Page ${p} : image trop grande, ignorée.`); continue }
          const png = await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
            { raw: { width: image.width, height: image.height, channels: image.channels } }).png().toBuffer()
          const r = await recognize(png)
          confidences.push(r.confidence)
          lines.push(...r.text.split('\n'))
        }
      } else {
        lines.push(...pageLines)
      }
    }
  } finally {
    await pdf.destroy()
  }
  const ocrUsed = confidences.length > 0
  return {
    text: lines.join('\n'), pages: pdf.numPages, ocrUsed,
    ocrConfidence: ocrUsed ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null, notes,
  }
}

function layoutRows(items: Item[]): string[] {
  // Rows: items whose baselines are within 3 pt, top to bottom.
  items.sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: Item[][] = []
  for (const item of items) {
    const row = rows.find(r => Math.abs(r[0]!.y - item.y) < 3)
    if (row) row.push(item)
    else rows.push([item])
  }
  const lines: string[] = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    let line = ''
    let end = -Infinity
    for (const item of row) {
      // A gap wider than ~2 spaces is a column break.
      const gap = item.x - end
      line += line === '' ? item.str : gap > 12 ? ` | ${item.str}` : gap > 1 ? ` ${item.str}` : item.str
      end = item.x + item.width
    }
    lines.push(line.replace(/\s+/g, ' ').trim())
  }
  return lines
}

async function xlsxText(bytes: Buffer): Promise<string> {
  await openSafeZip(bytes) // refuses zip bombs before exceljs decompresses anything
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  const lines: string[] = []
  wb.eachSheet(sheet => {
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: false }, cell => {
        const v = cell.value
        const text = v === null || v === undefined ? '' : typeof v === 'object' && 'result' in v ? String(v.result) : typeof v === 'object' && 'richText' in v ? v.richText.map(t => t.text).join('') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
        if (text.trim() !== '') cells.push(text.trim())
      })
      if (cells.length) lines.push(cells.join(' | '))
    })
  })
  return lines.join('\n')
}

function csvText(bytes: Buffer): string {
  const text = bytes.toString('utf8').replace(/^﻿/, '')
  const rows = text.split(/\r?\n/).filter(l => l.trim() !== '')
  const separator = [';', '\t', ','].find(s => rows.slice(0, 5).every(r => r.includes(s))) ?? ';'
  return rows.map(r => r.split(separator).map(c => c.replace(/^"|"$/g, '').trim()).filter(Boolean).join(' | ')).join('\n')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]!)
}

/** Word: headers (letterhead), body paragraphs and tables (one row per line, cells joined with " | "), footers. */
async function docxText(bytes: Buffer): Promise<string> {
  const zip = await openSafeZip(bytes)
  const parts = Object.keys(zip.files).filter(n => /^word\/(header\d*|document|footer\d*)\.xml$/.test(n))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  if (!parts.includes('word/document.xml')) throw new UnreadableDocument('Document Word sans contenu.')
  const out: string[] = []
  for (const name of parts) out.push(wordXmlText(await zip.file(name)!.async('string')))
  return out.filter(Boolean).join('\n')
}
const rank = (name: string) => (name.includes('header') ? 0 : name.includes('document') ? 1 : 2)

export function wordXmlText(xml: string): string {
  const lines: string[] = []
  let tableDepth = 0
  let row: string[] | null = null
  let cell: string[] | null = null
  let para = ''
  const token = /<w:tbl[ >]|<\/w:tbl>|<w:tr[ >]|<\/w:tr>|<w:tc[ >]|<\/w:tc>|<w:p[ >]|<w:p\/>|<\/w:p>|<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g
  for (const m of xml.matchAll(token)) {
    const t = m[0]
    if (t.startsWith('<w:tbl')) tableDepth++
    else if (t === '</w:tbl>') tableDepth = Math.max(0, tableDepth - 1)
    else if (t.startsWith('<w:tr')) row = []
    else if (t === '</w:tr>') { if (row && row.some(c => c)) lines.push(row.filter(c => c).join(' | ')); row = null }
    else if (t.startsWith('<w:tc')) cell = []
    else if (t === '</w:tc>') { if (row && cell) row.push(cell.join(' ').replace(/\s+/g, ' ').trim()); cell = null }
    else if (t.startsWith('<w:p') && t !== '</w:p>') para = ''
    else if (t === '</w:p>') {
      const text = para.replace(/[ \t]+/g, ' ').trim()
      if (cell) { if (text) cell.push(text) } else if (text) lines.push(text)
      para = ''
    } else if (t === '<w:tab/>') para += tableDepth ? ' ' : ' | '
    else if (t === '<w:br/>' || t === '<w:cr/>') para += '\n'
    else para += decodeXml(m[1] ?? '')
  }
  return lines.join('\n')
}
