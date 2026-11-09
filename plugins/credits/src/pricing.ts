/**
 * Deterministic pricing (rule 6: the code decides, never the model).
 *
 * Every amount is an integer:
 * - provider prices are in nano-USD per token (1 USD / 1M tokens = 1000 nano-USD per token),
 * - balances and charges are in milli-credits (1 credit = 1000 milli-credits).
 * BigInt is used for the intermediate products so no rounding drifts in.
 */

/** Token counts of one model call. Mirrors dsh `TokenUsage`: the counts are disjoint. */
export interface Usage {
  /** Uncached input tokens only. */
  inputTokens: number
  /** Output tokens. Reasoning tokens are part of this count, not added to it. */
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Provider price of one model, in USD per million tokens (as published by the provider). */
export interface ModelPrice {
  inputUsdPerMTok: number
  outputUsdPerMTok: number
  cacheReadUsdPerMTok?: number
  cacheWriteUsdPerMTok?: number
  /** Where the price comes from and when it was checked (rule 12). */
  source: string
}

export interface CreditPolicy {
  /** Sale value of one credit, in USD (e.g. 0.01). */
  creditValueUsd: number
  /** Margin over the provider cost, in percent (e.g. 30 means cost × 1.30). */
  markupPercent: number
}

const NANO_PER_USD = 1_000_000_000n
const MILLI_PER_CREDIT = 1000n

/** USD per million tokens → nano-USD per token, exact for prices with up to 3 decimals. */
export function usdPerMTokToNanoPerToken(usdPerMTok: number): bigint {
  if (!Number.isFinite(usdPerMTok) || usdPerMTok < 0) throw new RangeError(`invalid price: ${usdPerMTok}`)
  // 1 USD / 1M tokens = 1000 nano-USD per token. Round to whole nano-USD.
  return BigInt(Math.round(usdPerMTok * 1000))
}

function tokens(n: number | undefined): bigint {
  if (n === undefined) return 0n
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`invalid token count: ${n}`)
  return BigInt(n)
}

/** Provider cost of one call in nano-USD. Cache prices default to the input price when unknown. */
export function providerCostNanoUsd(usage: Usage, price: ModelPrice): bigint {
  const input = usdPerMTokToNanoPerToken(price.inputUsdPerMTok)
  const output = usdPerMTokToNanoPerToken(price.outputUsdPerMTok)
  const cacheRead = usdPerMTokToNanoPerToken(price.cacheReadUsdPerMTok ?? price.inputUsdPerMTok)
  const cacheWrite = usdPerMTokToNanoPerToken(price.cacheWriteUsdPerMTok ?? price.inputUsdPerMTok)
  return tokens(usage.inputTokens) * input
    + tokens(usage.outputTokens) * output
    + tokens(usage.cacheReadTokens) * cacheRead
    + tokens(usage.cacheWriteTokens) * cacheWrite
}

/** Milli-credits charged for one call: cost × (1 + markup), divided by the credit value, rounded up. */
export function chargeMilliCredits(usage: Usage, price: ModelPrice, policy: CreditPolicy): number {
  if (!(policy.creditValueUsd > 0)) throw new RangeError('creditValueUsd must be > 0')
  if (!(policy.markupPercent >= 0) || !Number.isInteger(policy.markupPercent)) {
    throw new RangeError('markupPercent must be a non-negative integer')
  }
  const cost = providerCostNanoUsd(usage, price)
  if (cost === 0n) return 0
  const creditValueNano = BigInt(Math.round(policy.creditValueUsd * 1e9))
  const numerator = cost * BigInt(100 + policy.markupPercent) * MILLI_PER_CREDIT
  const denominator = 100n * creditValueNano
  const charge = (numerator + denominator - 1n) / denominator
  return Number(charge)
}

export function creditsToMilli(credits: number): number {
  if (!Number.isFinite(credits) || credits < 0) throw new RangeError(`invalid credits: ${credits}`)
  return Math.round(credits * Number(MILLI_PER_CREDIT))
}

export function milliToCredits(milli: number): number {
  return milli / Number(MILLI_PER_CREDIT)
}

export { NANO_PER_USD }
