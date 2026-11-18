/** File type from the bytes, never from the name or the browser (directive 5.3, section 8). */
export type FileKind = 'pdf' | 'xlsx' | 'csv' | 'png' | 'jpeg' | 'webp' | 'docx' | 'txt'

export const IMAGE_KINDS = new Set<FileKind>(['png', 'jpeg', 'webp'])

/** Every kind a business document may arrive in (DIRECTIVES §4). */
export const DOCUMENT_KINDS = new Set<FileKind>(['pdf', 'xlsx', 'csv', 'png', 'jpeg', 'webp', 'docx', 'txt'])

export const KIND_LABEL: Record<FileKind, string> = {
  pdf: 'PDF', xlsx: 'Excel', csv: 'CSV', png: 'image PNG', jpeg: 'image JPEG', webp: 'image WebP', docx: 'Word (.docx)', txt: 'texte',
}

export const CONTENT_TYPES: Record<FileKind, string> = {
  pdf: 'application/pdf', csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
}

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b)
}

export function sniff(bytes: Buffer): FileKind | null {
  if (bytes.length < 4) return null
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML packages name their parts in the zip directory (stored uncompressed).
    const head = bytes.toString('latin1')
    if (!head.includes('[Content_Types].xml')) return null
    if (head.includes('xl/')) return 'xlsx'
    if (head.includes('word/')) return 'docx'
    return null
  }
  return textKind(bytes)
}

function textKind(bytes: Buffer): FileKind | null {
  const sample = bytes.subarray(0, 64 * 1024)
  if (sample.includes(0)) return null
  const text = sample.toString('utf8')
  if (text.includes('�')) return null
  if (/^\s*</.test(text)) return null // markup (HTML, SVG, XML) is neither a report nor a document we read
  // Control characters other than tab, line feed and carriage return: binary, not text.
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return null
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length === 0) return null
  if (lines.length >= 2) {
    const separator = [';', ',', '\t'].find(s => lines.slice(0, 5).every(l => l.includes(s)))
    if (separator !== undefined) return 'csv'
  }
  return 'txt'
}
