/**
 * Cleaning and chunking for the knowledge base (DIRECTIVES §3 B).
 * - Cleaning: Unicode normalisation, words split across lines rejoined, page numbers and repeated
 *   headers/footers removed, blank runs collapsed.
 * - Chunking: passages of about 900 characters cut at headings and paragraph ends, each carrying the heading
 *   it belongs to and a short overlap with the previous passage so no sentence loses its context.
 */

export interface Chunk { ordinal: number; heading: string | null; content: string }

const PAGE_NUMBER = /^(?:page\s*)?\d{1,4}(?:\s*(?:\/|sur|of)\s*\d{1,4})?$|^-\s*\d{1,4}\s*-$/i

export function cleanText(raw: string): string {
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/­/g, '').replace(/[\t  ]+/g, ' ')
  // "factu-\nration" → "facturation" (lowercase continuation only: "Lubumbashi-\nKolwezi" stays).
  const joined = text.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
  const lines = joined.split('\n').map(l => l.replace(/ {2,}/g, ' ').trim())
  // Short lines repeated on many pages are headers or footers.
  const counts = new Map<string, number>()
  for (const l of lines) if (l && l.length <= 80) counts.set(l, (counts.get(l) ?? 0) + 1)
  const out: string[] = []
  for (const l of lines) {
    if (PAGE_NUMBER.test(l)) continue
    if (l && l.length <= 80 && (counts.get(l) ?? 0) >= 3 && !/[.:;]$/.test(l)) continue
    if (!l && out[out.length - 1] === '') continue
    out.push(l)
  }
  return out.join('\n').trim()
}

/** A line that announces a section: numbered, "Article 3", or a short line in capitals. */
export function isHeading(line: string): boolean {
  const l = line.trim()
  if (l.length < 3 || l.length > 90 || /[.;,]$/.test(l)) return false
  if (/^(?:article|chapitre|section|titre|annexe|partie)\s+[\dIVXLC]+/i.test(l)) return true
  if (/^\d{1,2}(?:\.\d{1,2}){0,3}[.)]?\s+\p{L}/u.test(l)) return true
  const letters = l.replace(/[^\p{L}]/gu, '')
  return letters.length >= 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
}

export function chunkText(text: string, target = 900, overlap = 150): Chunk[] {
  const lines = cleanText(text).split('\n')
  const chunks: Chunk[] = []
  let heading: string | null = null
  let buffer: string[] = []
  let size = 0
  const flush = () => {
    const content = buffer.join('\n').trim()
    if (content.replace(/\s/g, '').length >= 20) chunks.push({ ordinal: chunks.length, heading, content })
    // Carry the end of this passage into the next one (whole sentences when possible).
    const tail = content.slice(-overlap)
    const sentence = tail.indexOf('. ')
    buffer = content.length > overlap ? [sentence >= 0 ? tail.slice(sentence + 2) : tail] : []
    size = buffer.join('').length
  }
  for (const line of lines) {
    if (isHeading(line)) {
      if (size > 0) { flush(); buffer = [] ; size = 0 }
      heading = line.trim().slice(0, 200)
      continue
    }
    if (!line) {
      if (size >= target * 0.6) flush()
      else if (buffer.length) buffer.push('')
      continue
    }
    // Very long lines (a paragraph with no breaks) are split at sentence ends.
    const pieces = line.length > target ? line.match(new RegExp(`[^.!?]{1,${target}}[.!?]?\\s*`, 'g')) ?? [line] : [line]
    for (const piece of pieces) {
      if (size + piece.length > target && size > 0) flush()
      buffer.push(piece.trim())
      size += piece.length + 1
    }
  }
  if (buffer.join('').trim().length) {
    const content = buffer.join('\n').trim()
    const last = chunks[chunks.length - 1]
    // Do not emit a passage that is only the overlap of the previous one.
    if (content.replace(/\s/g, '').length >= 20 && (!last || !last.content.endsWith(content))) chunks.push({ ordinal: chunks.length, heading, content })
  }
  return chunks
}
