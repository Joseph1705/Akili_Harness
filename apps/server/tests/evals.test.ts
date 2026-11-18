import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runExtractionEval } from '../src/ai/evals.js'
import { shutdownOcr } from '../src/documents/ocr.js'
import { extractInvoiceFields } from '../src/documents/invoice-fields.js'

afterAll(shutdownOcr)

describe('evaluation of document reading (local, no model)', () => {
  it('reads the fictitious documents at least 95 % right — a regression guard for every change', async () => {
    const result = await runExtractionEval(join(import.meta.dirname, '../../../fixtures'), async (text, identity) => extractInvoiceFields(text, identity))
    expect(result.cases).toBe(5)
    for (const d of result.details) expect(d.misses, d.file).toEqual([])
    expect(result.score).toBeGreaterThanOrEqual(0.95)
  })
})
