import { describe, expect, it } from 'vitest'
import { chargeMilliCredits, providerCostNanoUsd, type ModelPrice } from '../src/pricing.js'

// Fictitious prices for the tests only (rule 4: fixtures, not real data).
const price: ModelPrice = { inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2, source: 'test fixture' }

describe('pricing', () => {
  it('costs 1M input + 1M output tokens at the per-million prices', () => {
    expect(providerCostNanoUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price)).toBe(24_000_000_000n)
  })

  it('bills cache reads at their own price and cache writes at the input price when unset', () => {
    const cost = providerCostNanoUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, price)
    expect(cost).toBe(200_000_000n + 4_000_000_000n)
  })

  it('converts cost to milli-credits with the markup, rounding up', () => {
    // $24 × 1.30 = $31.20 = 3120 credits of $0.01 = 3,120,000 milli-credits
    expect(chargeMilliCredits({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price, { creditValueUsd: 0.01, markupPercent: 30 }))
      .toBe(3_120_000)
    // one output token: $20/MTok = 20,000 nano-USD × 1.3 = 26,000 nano-USD; a credit is 10^7 nano-USD
    // → 2.6 milli-credits → rounds up to 3
    expect(chargeMilliCredits({ inputTokens: 0, outputTokens: 1 }, price, { creditValueUsd: 0.01, markupPercent: 30 })).toBe(3)
  })

  it('charges nothing for an empty call', () => {
    expect(chargeMilliCredits({ inputTokens: 0, outputTokens: 0 }, price, { creditValueUsd: 0.01, markupPercent: 30 })).toBe(0)
  })

  it('rejects invalid token counts and policies', () => {
    expect(() => providerCostNanoUsd({ inputTokens: -1, outputTokens: 0 }, price)).toThrow()
    expect(() => providerCostNanoUsd({ inputTokens: 1.5, outputTokens: 0 }, price)).toThrow()
    expect(() => chargeMilliCredits({ inputTokens: 1, outputTokens: 0 }, price, { creditValueUsd: 0, markupPercent: 0 })).toThrow()
  })
})
