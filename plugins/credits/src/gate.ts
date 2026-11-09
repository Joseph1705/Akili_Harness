/**
 * The credit gate around one model call.
 *
 * Runs inside dsh's `llm/stream` waterfall: every model request (agent loop,
 * titles, compaction, subagents) passes through it. Order of checks:
 *   1. the route belongs to the organization's plan,
 *   2. the organization consented to an external model provider (rule 5),
 *   3. a price exists for the route (never consume without billing),
 *   4. the balance is at least the minimum to start a call.
 * Then the call runs, and the `usage` chunk is billed before it is passed on.
 *
 * A refused call ends with a terminal `finish { kind: 'error' }` chunk, one of the
 * two failure paths the dsh adapter contract allows, so the UI shows the message.
 */
import type { CreditLedger } from './ledger.js'
import { message, type Locale, type MessageKey } from './messages.js'
import { isRouteAllowed, routeKey, type PlanPolicy } from './plans.js'
import { chargeMilliCredits, milliToCredits, type CreditPolicy, type ModelPrice, type Usage } from './pricing.js'

/** Structural subset of dsh `GenerateOptions` the gate reads. */
export interface GateRequest {
  provider: string
  model: string
  sessionId?: string
  purpose?: string
}

/** Structural subset of dsh `StreamChunk`; unknown chunk types pass through untouched. */
export type GateChunk =
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: { kind: string; failure?: { message: string; code: string } } }
  | { type: string; [key: string]: unknown }

export interface GateConfig {
  orgId: string
  plan: PlanPolicy
  /** Explicit, recorded consent of the organization to send data to an external model provider. */
  externalModelConsent: boolean
  /** Prices by route `<provider>/<model>`. */
  prices: Record<string, ModelPrice>
  credit: CreditPolicy
  /** A call starts only when the balance is at least this many milli-credits. */
  minBalanceMilliCredits: number
  locale: Locale
}

export interface GateDeps {
  ledger: CreditLedger
  log?: (level: 'info' | 'warn' | 'error', text: string) => void
}

export type GateErrorCode = MessageKey

function refusal(code: GateErrorCode, text: string): GateChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message: text, code } } }
}

function isUsage(chunk: GateChunk): chunk is { type: 'usage'; usage: Usage } {
  return chunk.type === 'usage' && typeof (chunk as { usage?: unknown }).usage === 'object'
}

function isTerminal(chunk: GateChunk): boolean {
  return chunk.type === 'finish'
}

/** Wrap one model call. `next` starts the real call; it is not invoked when the gate refuses. */
export async function* gateStream(
  request: GateRequest,
  next: () => AsyncIterable<GateChunk>,
  config: GateConfig,
  deps: GateDeps,
): AsyncIterable<GateChunk> {
  const route = routeKey(request.provider, request.model)
  const t = (key: MessageKey, params?: Record<string, string>) => message(config.locale, key, params)

  if (!isRouteAllowed(config.plan, request.provider, request.model)) {
    yield refusal('PLAN_ROUTE_FORBIDDEN', t('PLAN_ROUTE_FORBIDDEN', { route, plan: config.plan.label }))
    return
  }
  if (!config.externalModelConsent) {
    yield refusal('EXTERNAL_MODEL_CONSENT_REQUIRED', t('EXTERNAL_MODEL_CONSENT_REQUIRED'))
    return
  }
  const price = config.prices[route]
  if (!price) {
    yield refusal('PRICE_UNKNOWN', t('PRICE_UNKNOWN', { route }))
    return
  }

  let balance: number
  try {
    balance = await deps.ledger.balance(config.orgId)
  } catch (error) {
    deps.log?.('error', `credits: cannot read the ledger: ${String(error)}`)
    yield refusal('LEDGER_UNAVAILABLE', t('LEDGER_UNAVAILABLE'))
    return
  }
  if (balance < config.minBalanceMilliCredits || balance <= 0) {
    yield refusal('CREDITS_EXHAUSTED', t('CREDITS_EXHAUSTED', { balance: milliToCredits(balance).toFixed(3) }))
    return
  }

  let billed = false
  let finished = false
  try {
    for await (const chunk of next()) {
      if (isUsage(chunk) && !billed) {
        billed = true
        const charge = chargeMilliCredits(chunk.usage, price, config.credit)
        // The ledger write is awaited before the usage chunk goes on, so a crash
        // after the response cannot lose the charge.
        await deps.ledger.record({
          orgId: config.orgId,
          kind: 'charge',
          milliCredits: -charge,
          ref: route,
          detail: {
            ...chunk.usage,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
            ...(request.purpose ? { purpose: request.purpose } : {}),
            priceSource: price.source,
          },
        })
      }
      if (isTerminal(chunk)) finished = true
      yield chunk
    }
  } finally {
    if (!billed) {
      // Aborted or failed before the provider reported usage. The provider may
      // still bill the partial call: record it at zero so it can be reconciled
      // against the provider invoice.
      await deps.ledger.record({
        orgId: config.orgId,
        kind: 'charge',
        milliCredits: 0,
        ref: route,
        detail: { unmetered: true, finished, ...(request.sessionId ? { sessionId: request.sessionId } : {}) },
      }).catch(error => deps.log?.('error', `credits: cannot record an unmetered call: ${String(error)}`))
    }
  }
}
