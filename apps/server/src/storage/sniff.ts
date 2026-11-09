/** File type from the bytes, never from the name or the browser (directive 5.3, section 8). */
export type FileKind = 'pdf' | 'xlsx' | 'csv' | 'png' | 'jpeg' | 'webp'

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
    // An Office Open XML workbook names its parts in the zip directory.
    const head = bytes.toString('latin1')
    return head.includes('[Content_Types].xml') && head.includes('xl/') ? 'xlsx' : null
  }
  return looksLikeCsv(bytes) ? 'csv' : null
}

function looksLikeCsv(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 64 * 1024)
  if (sample.includes(0)) return false
  const text = sample.toString('utf8')
  if (text.includes('�')) return false
  if (/^\s*</.test(text)) return false // markup (HTML, SVG, XML) is not a report
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) return false
  const separator = [';', ',', '\t'].find(s => lines.slice(0, 5).every(l => l.includes(s)))
  return separator !== undefined
}
