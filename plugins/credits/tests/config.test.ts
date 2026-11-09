import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('config', () => {
  it('resolves a company config with defaults', () => {
    const { gate, ledgerPath } = resolveConfig({ orgId: 'org-fictive', plan: 'entreprise' })
    expect(gate.plan.routes).toEqual([{ provider: 'anthropic', models: ['claude-opus-5-5'] }])
    expect(gate.externalModelConsent).toBe(false)
    expect(gate.locale).toBe('fr')
    expect(ledgerPath).toMatch(/\.akili\/credits\.jsonl$/)
  })

  it('requires a source on every price', () => {
    expect(() => resolveConfig({ orgId: 'o', plan: 'solo', prices: { 'deepseek-official/x': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } } }))
      .toThrow(/source/)
  })

  it('rejects unknown plans and malformed routes', () => {
    expect(() => resolveConfig({ orgId: 'o', plan: 'gold' })).toThrow(/plan/)
    expect(() => resolveConfig({ orgId: 'o', plan: 'solo', prices: { nope: { inputUsdPerMTok: 1, outputUsdPerMTok: 1, source: 's' } } }))
      .toThrow(/provider/)
  })
})
