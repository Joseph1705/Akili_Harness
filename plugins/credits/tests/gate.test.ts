import { describe, expect, it } from 'vitest'
import { gateStream, type GateChunk, type GateConfig } from '../src/gate.js'
import { MemoryLedger } from '../src/ledger.js'
import { DEFAULT_PLANS } from '../src/plans.js'

const opus = 'anthropic/claude-opus-5-5'
const deepseek = 'deepseek-official/deepseek-v4-pro'

function config(overrides: Partial<GateConfig> = {}): GateConfig {
  return {
    orgId: 'org-fictive',
    plan: DEFAULT_PLANS.entreprise,
    externalModelConsent: true,
    // Fictitious prices for the tests only.
    prices: {
      [opus]: { inputUsdPerMTok: 4, outputUsdPerMTok: 20, source: 'test fixture' },
      [deepseek]: { inputUsdPerMTok: 1, outputUsdPerMTok: 2, source: 'test fixture' },
    },
    credit: { creditValueUsd: 0.01, markupPercent: 30 },
    minBalanceMilliCredits: 1000,
    locale: 'fr',
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<GateChunk>): Promise<GateChunk[]> {
  const out: GateChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function provider(chunks: GateChunk[]) {
  const calls = { count: 0 }
  const next = async function* () {
    calls.count++
    for (const chunk of chunks) yield chunk
  }
  return { next, calls }
}

const okCall: GateChunk[] = [
  { type: 'block-start', index: 0 },
  { type: 'usage', usage: { inputTokens: 10_000, outputTokens: 2_000 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

async function funded(milli = 100_000) {
  const ledger = new MemoryLedger()
  await ledger.record({ orgId: 'org-fictive', kind: 'topup', milliCredits: milli, ref: 'pay-test' })
  return ledger
}

function failureCode(chunks: GateChunk[]): string | undefined {
  const last = chunks.at(-1) as { type: string; reason?: { kind: string; failure?: { code: string } } }
  return last.type === 'finish' && last.reason?.kind === 'error' ? last.reason.failure?.code : undefined
}

describe('credit gate', () => {
  it('passes every chunk through and bills the usage', async () => {
    const ledger = await funded()
    const { next, calls } = provider(okCall)
    const out = await collect(gateStream({ provider: 'anthropic', model: 'claude-opus-5-5', sessionId: 's1' }, next, config(), { ledger }))
    expect(out).toEqual(okCall)
    expect(calls.count).toBe(1)
    // cost = 10k × 4000 + 2k × 20000 nano-USD = 80,000,000 nano = $0.08; ×1.3 = $0.104 = 10.4 credits = 10,400 mc
    expect(await ledger.balance('org-fictive')).toBe(100_000 - 10_400)
    const charge = (await ledger.entries('org-fictive')).at(-1)!
    expect(charge).toMatchObject({ kind: 'charge', milliCredits: -10_400, ref: opus })
    expect(charge.detail).toMatchObject({ sessionId: 's1', priceSource: 'test fixture' })
  })

  it('keeps a solo account on DeepSeek', async () => {
    const ledger = await funded()
    const { next, calls } = provider(okCall)
    const out = await collect(gateStream({ provider: 'anthropic', model: 'claude-opus-5-5' }, next, config({ plan: DEFAULT_PLANS.solo }), { ledger }))
    expect(failureCode(out)).toBe('PLAN_ROUTE_FORBIDDEN')
    expect(calls.count).toBe(0)

    const allowed = provider(okCall)
    await collect(gateStream({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, allowed.next, config({ plan: DEFAULT_PLANS.solo }), { ledger }))
    expect(allowed.calls.count).toBe(1)
  })

  it('keeps a company account on Claude Opus 5.5', async () => {
    const ledger = await funded()
    const { next, calls } = provider(okCall)
    const out = await collect(gateStream({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, next, config(), { ledger }))
    expect(failureCode(out)).toBe('PLAN_ROUTE_FORBIDDEN')
    expect(calls.count).toBe(0)
  })

  it('sends nothing to a provider without the organization consent', async () => {
    const { next, calls } = provider(okCall)
    const out = await collect(gateStream({ provider: 'anthropic', model: 'claude-opus-5-5' }, next, config({ externalModelConsent: false }), { ledger: await funded() }))
    expect(failureCode(out)).toBe('EXTERNAL_MODEL_CONSENT_REQUIRED')
    expect(calls.count).toBe(0)
  })

  it('refuses a route with no price instead of running it unbilled', async () => {
    const { next, calls } = provider(okCall)
    const out = await collect(gateStream({ provider: 'anthropic', model: 'claude-opus-5-5' }, next, config({ prices: {} }), { ledger: await funded() }))
    expect(failureCode(out)).toBe('PRICE_UNKNOWN')
    expect(calls.count).toBe(0)
  })

  it('blocks when the credits are used up, with a French message', async () => {
    const { next, calls } = provider(okCall)
    const out = await collect(gateStream({ provider: 'anthropic', model: 'claude-opus-5-5' }, next, config(), { ledger: await funded(500) }))
    expect(failureCode(out)).toBe('CREDITS_EXHAUSTED')
    expect(JSON.stringify(out)).toContain('Crédits épuisés')
    expect(calls.count).toBe(0)
  })

  it('records an unmetered entry when the call ends without usage', async () => {
    const ledger = await funded()
    const { next } = provider([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'stop', code: 'ABORTED' } } }])
    await collect(gateStream({ provider: 'anthropic', model: 'claude-opus-5-5' }, next, config(), { ledger }))
    expect((await ledger.entries('org-fictive')).at(-1)).toMatchObject({ kind: 'charge', milliCredits: 0, detail: { unmetered: true } })
    expect(await ledger.balance('org-fictive')).toBe(100_000)
  })

  it('records an unmetered entry when the consumer stops early', async () => {
    const ledger = await funded()
    const { next } = provider(okCall)
    for await (const chunk of gateStream({ provider: 'anthropic', model: 'claude-opus-5-5' }, next, config(), { ledger })) {
      void chunk
      break
    }
    expect((await ledger.entries('org-fictive')).at(-1)).toMatchObject({ milliCredits: 0, detail: { unmetered: true } })
  })

  it('fails closed when the ledger cannot be read', async () => {
    const ledger = new MemoryLedger()
    ledger.balance = async () => { throw new Error('disk gone') }
    const { next, calls } = provider(okCall)
    const out = await collect(gateStream({ provider: 'anthropic', model: 'claude-opus-5-5' }, next, config(), { ledger }))
    expect(failureCode(out)).toBe('LEDGER_UNAVAILABLE')
    expect(calls.count).toBe(0)
  })
})
