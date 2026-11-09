/** Invoice PDF in the brand layout (design screen C). Always marked "Document non fiscal — projet de facture" (rule 8). */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import PDFDocument from 'pdfkit'
import { formatMoney, formatQty } from './compute.js'
import type { Check, InvoiceLine } from './draft.js'

const require = createRequire(import.meta.url)
const font = (pkg: string, file: string) => join(dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files', file)
const FONTS = {
  sans: font('ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff'),
  sansBold: font('ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff'),
  serif: font('ibm-plex-serif', 'ibm-plex-serif-latin-600-normal.woff'),
  // Plex Mono's font file breaks pdfkit's embedding (fontkit DataView error); amounts use Plex Sans.
  mono: font('ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff'),
}

const GREEN = '#00603A'
const INK = '#16211B'
const MUTED = '#4D5A52'
const ALERT = '#8A4A0E'

export interface InvoicePdfData {
  status: 'draft' | 'validated' | 'rejected'
  number: string
  issueDate: string
  dueDate: string
  poNumber: string
  period: string | null
  currency: string
  provider: { name: string; address: string | null; rccm: string | null; nif: string | null; idNat: string | null; bank: string | null }
  client: { name: string; address: string | null; nif: string | null }
  lines: InvoiceLine[]
  subtotalCents: number
  vatRateBp: number
  vatCents: number
  totalCents: number
  checks: Check[]
  logoPng: Buffer | null
}

const frDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')

export function renderInvoicePdf(d: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${d.number} — Document non fiscal`, Author: d.provider.name } })
    const chunks: Buffer[] = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.registerFont('sans', FONTS.sans).registerFont('sansBold', FONTS.sansBold).registerFont('serif', FONTS.serif).registerFont('mono', FONTS.mono)

    const left = 50
    const right = 545
    // Header: provider, then FACTURE.
    let y = 50
    if (d.logoPng) { doc.image(d.logoPng, left, y, { width: 42, height: 42 }); }
    const px = d.logoPng ? left + 54 : left
    doc.font('sansBold').fontSize(11).fillColor(INK).text(d.provider.name, px, y)
    doc.font('sans').fontSize(8.5).fillColor(MUTED)
    for (const l of [d.provider.address, d.provider.rccm && `RCCM ${d.provider.rccm}`, d.provider.idNat && `Id. Nat. ${d.provider.idNat}`, d.provider.nif && `NIF ${d.provider.nif}`].filter(Boolean)) doc.text(String(l), px)
    doc.font('serif').fontSize(22).fillColor(INK).text('FACTURE', 330, 48, { width: right - 330, align: 'right' })
    doc.font('mono').fontSize(9).fillColor(MUTED).text(`N° ${d.number}`, 330, 76, { width: right - 330, align: 'right' })
    if (d.status === 'draft') doc.font('sansBold').fontSize(8).fillColor(ALERT).text('PROJET — NON VALIDÉ', 330, 90, { width: right - 330, align: 'right' })
    if (d.status === 'rejected') doc.font('sansBold').fontSize(8).fillColor('#9E2A1E').text('REJETÉE', 330, 90, { width: right - 330, align: 'right' })

    // Billed to + dates.
    y = 140
    doc.moveTo(left, y).lineTo(290, y).lineWidth(1.2).strokeColor(INK).stroke()
    doc.moveTo(310, y).lineTo(right, y).stroke()
    doc.font('sansBold').fontSize(7.5).fillColor(MUTED).text('FACTURÉ À', left, y + 8)
    doc.font('sansBold').fontSize(10).fillColor(INK).text(d.client.name, left, y + 20)
    doc.font('sans').fontSize(8.5).fillColor(MUTED).text([d.client.address, d.client.nif && `NIF ${d.client.nif}`].filter(Boolean).join(' · '), left, y + 34, { width: 240 })
    const meta: Array<[string, string]> = [['Date', frDate(d.issueDate)], ['Bon de commande', d.poNumber], ['Échéance', frDate(d.dueDate)]]
    if (d.period) meta.push(['Période', d.period])
    meta.forEach(([k, v], i) => {
      doc.font('sans').fontSize(8.5).fillColor(MUTED).text(k, 310, y + 8 + i * 15)
      doc.font('mono').fontSize(8.5).fillColor(INK).text(v, 410, y + 8 + i * 15, { width: right - 410 })
    })

    // Lines.
    y = 230
    const cols = { label: left, qty: 300, unit: 360, total: 450 }
    doc.font('sansBold').fontSize(7.5).fillColor(MUTED)
    doc.text('DÉSIGNATION', cols.label, y).text('QTÉ', cols.qty, y, { width: 50, align: 'right' })
    doc.text(`P.U. ${d.currency}`, cols.unit, y, { width: 80, align: 'right' }).text(`TOTAL ${d.currency}`, cols.total, y, { width: right - cols.total, align: 'right' })
    y += 14
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1.2).strokeColor(INK).stroke()
    y += 8
    for (const l of d.lines) {
      doc.font('sans').fontSize(9).fillColor(INK).text(l.label, cols.label, y, { width: 240 })
      const h = Math.max(doc.heightOfString(l.label, { width: 240 }), 12)
      doc.font('mono').fontSize(9)
      doc.text(`${formatQty(l.qty_milli)} ${shortUnit(l.unit)}`, cols.qty - 20, y, { width: 70, align: 'right' })
      doc.text(formatMoney(l.unit_cents), cols.unit, y, { width: 80, align: 'right' })
      doc.text(formatMoney(l.amount_cents), cols.total, y, { width: right - cols.total, align: 'right' })
      y += h + 10
      doc.moveTo(left, y - 5).lineTo(right, y - 5).lineWidth(0.4).strokeColor('#C9D2CB').stroke()
    }

    // Totals.
    y += 6
    const totalRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'sansBold' : 'sans').fontSize(bold ? 10 : 9).fillColor(INK).text(label, 330, y)
      doc.font('mono').fontSize(bold ? 11 : 9).text(value, 430, y, { width: right - 430, align: 'right' })
      y += bold ? 20 : 15
    }
    totalRow('Total HT', formatMoney(d.subtotalCents))
    totalRow(d.vatRateBp ? `TVA ${d.vatRateBp / 100} %` : 'TVA non applicable', formatMoney(d.vatCents))
    doc.moveTo(330, y - 3).lineTo(right, y - 3).lineWidth(1.2).strokeColor(INK).stroke()
    y += 3
    totalRow('Total TTC', `${formatMoney(d.totalCents)} ${d.currency}`, true)

    // Payment and legal mentions.
    y += 16
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor('#C9D2CB').stroke()
    if (d.provider.bank) doc.font('sans').fontSize(8.5).fillColor(MUTED).text(d.provider.bank, left, y + 8, { width: right - left })
    doc.rect(left, 760, right - left, 34).fillColor('#F6F2E9').fill()
    doc.font('sansBold').fontSize(8.5).fillColor(GREEN).text('Document non fiscal — projet de facture', left + 10, 767)
    doc.font('sans').fontSize(7.5).fillColor(MUTED).text("Ce document n'est pas une facture normalisée DGI. La facture fiscale est émise par votre dispositif électronique fiscal homologué.", left + 10, 779, { width: right - left - 20 })
    doc.end()
  })
}

function shortUnit(unit: string): string {
  const map: Record<string, string> = { jour: 'j', heure: 'h', 'mètre': 'm', forfait: '', 'agent-jour': 'a-j' }
  return map[unit] ?? unit
}
