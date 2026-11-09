import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractText } from '../src/documents/extract.js'
import { parseReport, suspiciousInstructions } from '../src/documents/parse-report.js'
import { sniff } from '../src/storage/sniff.js'

const dir = resolve(import.meta.dirname, '../../../fixtures/reports')
const load = async (name: string) => {
  const bytes = readFileSync(join(dir, name))
  return parseReport(await extractText(bytes, sniff(bytes)!))
}

describe('report extraction', () => {
  it('reads the nominal PDF report', async () => {
    const r = await load('RA-2026-10-014_Tshala_Kipushi.pdf')
    expect(r).toMatchObject({ number: 'RA-2026-10-014', po: 'BC-0932', client: 'Tshala Logistique SARL', site: 'Kipushi — Puits 3', period: '01/10/2026 au 31/10/2026' })
    expect(r.lines).toEqual([
      { code: 'GRU-25', label: 'Location grue mobile 25 t — site Kipushi', unit: 'jour', qty: '12' },
      { code: 'OPE-CERT', label: 'Opérateur certifié (heures)', unit: 'heure', qty: '96' },
      { code: 'TRA-AR', label: 'Transport aller-retour et mise en place', unit: 'forfait', qty: '1' },
    ])
  })

  it('reads decimal quantities written with a comma', async () => {
    const r = await load('RA-2026-10-021_Kalembe_Forage.pdf')
    expect(r.lines[0]).toMatchObject({ code: 'FOR-DTH', qty: '1240.5' })
  })

  it('reads the Excel and CSV reports', async () => {
    const x = await load('RA-2026-10-015_Tshala_Kipushi.xlsx')
    expect(x).toMatchObject({ number: 'RA-2026-10-015', po: 'BC-0932' })
    expect(x.lines.map(l => [l.code, l.qty])).toEqual([['GRU-25', '6'], ['OPE-CERT', '48']])
    const c = await load('RA-2026-10-022_Kalembe_Transport.csv')
    expect(c.lines.map(l => [l.code, l.qty])).toEqual([['CAM-30', '212.5'], ['NIV-140', '38']])
  })

  it('keeps the remarks as data and flags instructions aimed at the agent', async () => {
    const r = await load('RA-2026-10-032_Tshala_Observations.pdf')
    expect(r.remarks).toContain('1 000 000 USD')
    expect(suspiciousInstructions(r.remarks ?? '')).toBe(true)
    expect(suspiciousInstructions('Levage des pompes du puits 3 terminé le 28/10. Aucun incident.')).toBe(false)
    expect(r.lines.map(l => l.qty)).toEqual(['3', '24'])
  })

  it('says what is missing when a document is not an activity report', () => {
    expect(() => parseReport('Facture fournisseur\nMontant : 200 USD')).toThrow(/Rapport N°|Bon de commande/)
  })
})
