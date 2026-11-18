/**
 * Agent evaluations (DIRECTIVES §3 H): how well documents are read, measured on the fictitious documents of
 * fixtures/documents against expected values. Run locally (no model) in tests and CI, or with the model of an
 * organization that enabled AI, to compare methods. Scores are stored for history.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDocument } from '../documents/extract.js'
import { extractInvoiceFields, type ExtractedInvoice, type OrgIdentity } from '../documents/invoice-fields.js'
import type { FileKind } from '../storage/sniff.js'
import { extractWithModel } from './extract.js'

interface Case { file: string; kind: FileKind; expect: { client: string | null; reference: string | null; total: string | null; lines: Array<[string, string]> } }
interface Suite { organization: OrgIdentity; cases: Case[] }

export interface EvalResult { cases: number; score: number; details: Array<{ file: string; score: number; misses: string[] }> }

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

export function scoreCase(fields: ExtractedInvoice, expected: Case['expect']): { score: number; misses: string[] } {
  const checks: Array<[string, boolean]> = [
    ['client', expected.client === null ? true : norm(fields.client.name) === norm(expected.client)],
    ['référence', expected.reference === null ? true : fields.reference === expected.reference],
    ['total', expected.total === null ? true : fields.total === expected.total],
    ['nombre de lignes', fields.lines.length === expected.lines.length],
    ...expected.lines.map(([qty, price], i): [string, boolean] => [`ligne ${i + 1}`, fields.lines[i]?.quantity === qty && fields.lines[i]?.unit_price === price]),
  ]
  const passed = checks.filter(([, ok]) => ok).length
  return { score: passed / checks.length, misses: checks.filter(([, ok]) => !ok).map(([name]) => name) }
}

export function loadSuite(fixturesDir: string): Suite {
  return JSON.parse(readFileSync(join(fixturesDir, 'documents', 'expected.json'), 'utf8')) as Suite
}

export async function runExtractionEval(fixturesDir: string, extract: (text: string, identity: OrgIdentity) => Promise<ExtractedInvoice>): Promise<EvalResult> {
  const suite = loadSuite(fixturesDir)
  const details: EvalResult['details'] = []
  for (const c of suite.cases) {
    const read = await readDocument(readFileSync(join(fixturesDir, 'documents', c.file)), c.kind)
    const fields = await extract(read.text, suite.organization)
    const { score, misses } = scoreCase(fields, c.expect)
    details.push({ file: c.file, score: Math.round(score * 1000) / 1000, misses })
  }
  const score = details.reduce((a, d) => a + d.score, 0) / Math.max(1, details.length)
  return { cases: details.length, score: Math.round(score * 10_000) / 10_000, details }
}

/** Local reading, or the model of `orgId` (which must have AI enabled for documents). */
export async function evaluate(app: FastifyInstance, fixturesDir: string, method: 'local' | 'model', orgId: string | null, userId: string | null): Promise<EvalResult & { id: string }> {
  const result = await runExtractionEval(fixturesDir, async (text, identity) => {
    if (method === 'local' || !orgId) return extractInvoiceFields(text, identity)
    const viaModel = await extractWithModel(app, orgId, text, identity, { documentId: randomUUID() })
    if (!viaModel) throw new Error("L'IA n'est pas activée pour les documents de cette organisation.")
    return viaModel.fields
  })
  const id = randomUUID()
  await app.deps.db.run('INSERT INTO ai_evals (id, org_id, suite, method, cases, score, details, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, orgId, 'extraction-documents-fictifs', method, result.cases, result.score, JSON.stringify(result.details), userId)
  return { ...result, id }
}
