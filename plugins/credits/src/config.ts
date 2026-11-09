/** Plugin configuration, validated by hand so the plugin has no runtime dependency on dsh internals. */
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { GateConfig } from './gate.js'
import type { Locale } from './messages.js'
import { DEFAULT_PLANS, type PlanId } from './plans.js'
import { creditsToMilli, type ModelPrice } from './pricing.js'

export interface RawConfig {
  orgId?: unknown
  plan?: unknown
  externalModelConsent?: unknown
  ledgerPath?: unknown
  creditValueUsd?: unknown
  markupPercent?: unknown
  minBalanceCredits?: unknown
  locale?: unknown
  prices?: unknown
}

export interface ResolvedConfig {
  gate: GateConfig
  ledgerPath: string
}

function fail(field: string, why: string): never {
  throw new Error(`akili-credits: invalid config "${field}": ${why}`)
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path)
}

function parsePrice(route: string, value: unknown): ModelPrice {
  if (typeof value !== 'object' || value === null) fail(`prices.${route}`, 'must be an object')
  const v = value as Record<string, unknown>
  const num = (key: string, required: boolean): number | undefined => {
    const n = v[key]
    if (n === undefined && !required) return undefined
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) fail(`prices.${route}.${key}`, 'must be a number >= 0')
    return n
  }
  if (typeof v.source !== 'string' || v.source.trim() === '') {
    fail(`prices.${route}.source`, 'say where the price comes from and when it was checked')
  }
  const price: ModelPrice = {
    inputUsdPerMTok: num('inputUsdPerMTok', true)!,
    outputUsdPerMTok: num('outputUsdPerMTok', true)!,
    source: v.source,
  }
  const cacheRead = num('cacheReadUsdPerMTok', false)
  const cacheWrite = num('cacheWriteUsdPerMTok', false)
  if (cacheRead !== undefined) price.cacheReadUsdPerMTok = cacheRead
  if (cacheWrite !== undefined) price.cacheWriteUsdPerMTok = cacheWrite
  return price
}

export function resolveConfig(raw: RawConfig): ResolvedConfig {
  if (typeof raw.orgId !== 'string' || raw.orgId.trim() === '') fail('orgId', 'required string')
  if (raw.plan !== 'solo' && raw.plan !== 'entreprise') fail('plan', 'must be "solo" or "entreprise"')
  const locale: Locale = raw.locale === undefined ? 'fr' : (raw.locale === 'fr' || raw.locale === 'en')
    ? raw.locale
    : fail('locale', 'must be "fr" or "en"')
  if (raw.externalModelConsent !== undefined && typeof raw.externalModelConsent !== 'boolean') {
    fail('externalModelConsent', 'must be true or false')
  }
  const creditValueUsd = raw.creditValueUsd ?? 0.01
  if (typeof creditValueUsd !== 'number' || !(creditValueUsd > 0)) fail('creditValueUsd', 'must be a number > 0')
  const markupPercent = raw.markupPercent ?? 0
  if (typeof markupPercent !== 'number' || !Number.isInteger(markupPercent) || markupPercent < 0) {
    fail('markupPercent', 'must be an integer >= 0')
  }
  const minBalanceCredits = raw.minBalanceCredits ?? 0
  if (typeof minBalanceCredits !== 'number' || minBalanceCredits < 0) fail('minBalanceCredits', 'must be a number >= 0')
  const ledgerPath = raw.ledgerPath ?? '~/.akili/credits.jsonl'
  if (typeof ledgerPath !== 'string' || ledgerPath === '') fail('ledgerPath', 'must be a path')

  const prices: Record<string, ModelPrice> = {}
  if (raw.prices !== undefined) {
    if (typeof raw.prices !== 'object' || raw.prices === null) fail('prices', 'must be an object keyed by <provider>/<model>')
    for (const [route, value] of Object.entries(raw.prices as Record<string, unknown>)) {
      if (!route.includes('/')) fail(`prices.${route}`, 'key must be <provider>/<model>')
      prices[route] = parsePrice(route, value)
    }
  }

  return {
    ledgerPath: expandHome(ledgerPath),
    gate: {
      orgId: raw.orgId,
      plan: DEFAULT_PLANS[raw.plan as PlanId],
      externalModelConsent: raw.externalModelConsent === true,
      prices,
      credit: { creditValueUsd, markupPercent },
      minBalanceMilliCredits: creditsToMilli(minBalanceCredits),
      locale,
    },
  }
}
