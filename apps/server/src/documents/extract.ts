/**
 * Plain text from a report file. Table cells are joined with " | " and each row is one line,
 * so PDF, Excel and CSV reports reach the parser in the same layout. The content is data,
 * never instructions (rule 9).
 */
import ExcelJS from 'exceljs'
import { getDocumentProxy } from 'unpdf'
import type { FileKind } from '../storage/sniff.js'

export async function extractText(bytes: Buffer, kind: FileKind): Promise<string> {
  switch (kind) {
    case 'pdf': return pdfText(bytes)
    case 'xlsx': return xlsxText(bytes)
    case 'csv': return csvText(bytes)
    default: throw new Error(`extract: unsupported kind ${kind}`)
  }
}

interface Item { str: string; x: number; y: number; width: number }

async function pdfText(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false })
  const lines: string[] = []
  const pages = Math.min(pdf.numPages, 50)
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    const items: Item[] = []
    for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
      if (!raw.str || !raw.transform || raw.str.trim() === '') continue
      items.push({ str: raw.str, x: raw.transform[4]!, y: raw.transform[5]!, width: raw.width ?? 0 })
    }
    // Rows: items whose baselines are within 3 pt, top to bottom.
    items.sort((a, b) => b.y - a.y || a.x - b.x)
    const rows: Item[][] = []
    for (const item of items) {
      const row = rows.find(r => Math.abs(r[0]!.y - item.y) < 3)
      if (row) row.push(item)
      else rows.push([item])
    }
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
  }
  await pdf.destroy()
  return lines.join('\n')
}

async function xlsxText(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  const lines: string[] = []
  wb.eachSheet(sheet => {
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: false }, cell => {
        const v = cell.value
        const text = v === null || v === undefined ? '' : typeof v === 'object' && 'result' in v ? String(v.result) : typeof v === 'object' && 'richText' in v ? v.richText.map(t => t.text).join('') : String(v)
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
