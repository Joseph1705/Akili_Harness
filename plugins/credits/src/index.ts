/**
 * akili-credits: prepaid credits and plan-based model routing for DeepSeek Harness.
 *
 * Mounted through a Cordis patch overlay (see config/akili.patch.yml); it does not
 * modify the dsh core. It listens to the `llm/stream` waterfall, which every model
 * call goes through, and applies the credit gate (src/gate.ts).
 */
import { FileLedger } from './ledger.js'
import { gateStream, type GateChunk, type GateRequest } from './gate.js'
import { resolveConfig, type RawConfig } from './config.js'

export * from './pricing.js'
export * from './plans.js'
export * from './ledger.js'
export * from './gate.js'
export { resolveConfig } from './config.js'

/**
 * Structural subset of the Cordis `Context` this plugin uses. Kept local so the
 * plugin builds and tests without importing dsh internals; `pnpm smoke`
 * (scripts/smoke.mjs) checks it against the pinned dsh version.
 */
export interface CreditsContext {
  on(
    event: 'llm/stream',
    listener: (options: GateRequest, next: () => AsyncIterable<GateChunk>) => AsyncIterable<GateChunk>,
  ): () => void
  logger?: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

export const name = 'akili-credits'
export const inject = ['llm']

export function apply(ctx: CreditsContext, raw: RawConfig): void {
  const { gate, ledgerPath } = resolveConfig(raw ?? {})
  const ledger = new FileLedger(ledgerPath)
  const log = (level: 'info' | 'warn' | 'error', text: string) => ctx.logger?.[level](text)
  log('info', `akili-credits: org "${gate.orgId}", plan "${gate.plan.id}", ledger ${ledgerPath}`)
  ctx.on('llm/stream', (options, next) => gateStream(options, next, gate, { ledger, log }))
}
