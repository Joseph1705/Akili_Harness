/**
 * Which model answers, and whether one may answer at all (DIRECTIVES §3 G, rule 5).
 *
 * - Nothing is sent to a model provider unless the organization switched AI on; an external provider also
 *   needs the organization's recorded consent. In "local" mode only a model on our own servers is used.
 * - Tiers: a light model for short, simple work; a heavy model for long or complex work (tools, long documents).
 * - Order of providers follows the organization's offer (Entreprise: Claude first; Entrepreneur: DeepSeek first),
 *   then the others configured on this server. A provider that fails (unavailable, rate limit, refusal) is
 *   skipped and the next one is tried; every attempt is a step of the run.
 * - A monthly token ceiling per organization protects against runaway cost.
 * - External providers only ever receive pseudonymised text (pseudonymize.ts).
 */
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db.js'
import { HttpError } from '../errors.js'
import { consentState } from '../orgs/consents.js'
import { anthropicProvider } from './providers/anthropic.js'
import { openAiCompatibleProvider } from './providers/openai-compatible.js'
import type { Run } from './runs.js'
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderId } from './types.js'

export type Tier = 'light' | 'heavy'

export interface AiSettings {
  enabled: boolean
  mode: 'external' | 'local'
  use_for_extraction: boolean
  use_for_chat: boolean
  whatsapp_drafts: boolean
  monthly_token_limit: number | null
}

export const DEFAULT_SETTINGS: AiSettings = { enabled: false, mode: 'external', use_for_extraction: true, use_for_chat: true, whatsapp_drafts: false, monthly_token_limit: null }

export async function aiSettings(db: Db, orgId: string): Promise<AiSettings> {
  return (await db.get<AiSettings>('SELECT enabled, mode, use_for_extraction, use_for_chat, whatsapp_drafts, monthly_token_limit FROM ai_settings WHERE org_id = ?', orgId)) ?? { ...DEFAULT_SETTINGS }
}

interface Candidate { provider: ModelProvider; models: { light: string; heavy: string } }

/** Providers configured on this server, built once per process. */
const providerCache = new WeakMap<object, Partial<Record<ProviderId, Candidate>>>()
function serverProviders(app: FastifyInstance): Partial<Record<ProviderId, Candidate>> {
  const cfg = app.deps.config.ai
  let found = providerCache.get(cfg)
  if (!found) {
    found = {}
    if (cfg.anthropic) found.anthropic = { provider: anthropicProvider(cfg.anthropic), models: cfg.anthropic.models }
    if (cfg.deepseek) found.deepseek = { provider: openAiCompatibleProvider('deepseek', cfg.deepseek, true), models: cfg.deepseek.models }
    if (cfg.local) found.local = { provider: openAiCompatibleProvider('local', cfg.local, cfg.local.external), models: cfg.local.models }
    providerCache.set(cfg, found)
  }
  return found
}

export interface AiAccess {
  allowed: boolean
  /** Why AI cannot be used, in plain French, when it cannot. */
  reason: string | null
  settings: AiSettings
  externalConsent: boolean
  /** Providers usable for this organization, in order of preference. */
  order: ProviderId[]
}

export async function aiAccess(app: FastifyInstance, orgId: string, purpose: 'chat' | 'extraction' | 'whatsapp' = 'chat'): Promise<AiAccess> {
  const { db } = app.deps
  const settings = await aiSettings(db, orgId)
  const consent = (await consentState(db, orgId)).external_model
  const plan = (await db.get<{ plan: 'solo' | 'entreprise' }>('SELECT plan FROM organizations WHERE id = ?', orgId))?.plan ?? 'entreprise'
  const available = serverProviders(app)
  // The "local" slot counts as ours only when it runs on our network (config.ts); otherwise it is one more external provider.
  const ownLocal = Boolean(available.local) && !app.deps.config.ai.local?.external
  const preferred: ProviderId[] = settings.mode === 'local' ? ['local'] : plan === 'solo' ? ['deepseek', 'anthropic', 'local'] : ['anthropic', 'deepseek', 'local']
  const order = preferred.filter(p => available[p] && ((p === 'local' && ownLocal) || consent) && !(settings.mode === 'local' && !ownLocal))
  const deny = (reason: string): AiAccess => ({ allowed: false, reason, settings, externalConsent: consent, order })
  if (!settings.enabled) return deny("L'intelligence artificielle est désactivée pour votre organisation. Un administrateur peut l'activer dans Paramètres › Intelligence artificielle.")
  if (purpose === 'extraction' && !settings.use_for_extraction) return deny("La lecture des documents par l'IA est désactivée : lecture locale uniquement.")
  if (purpose === 'chat' && !settings.use_for_chat) return deny("L'assistant conversationnel est désactivé pour votre organisation.")
  if (purpose === 'whatsapp' && !settings.whatsapp_drafts) return deny("Les brouillons de réponse WhatsApp par l'IA sont désactivés.")
  if (settings.mode === 'local' && !ownLocal) return deny("Le mode local est choisi, mais aucun modèle n'est installé sur nos propres serveurs.")
  if (settings.mode === 'external' && !consent && !ownLocal) return deny("L'organisation n'a pas donné son consentement à l'envoi de données (pseudonymisées) à un fournisseur de modèle externe.")
  if (order.length === 0) return deny("Aucun modèle de langage n'est configuré sur ce serveur.")
  return { allowed: true, reason: null, settings, externalConsent: consent, order }
}

export function chooseTier(task: 'chat' | 'extraction' | 'whatsapp' | 'title', signals: { chars: number; tools?: number; retrieved?: number }): Tier {
  if (task === 'title') return 'light'
  if (task === 'extraction') return signals.chars > 4_000 ? 'heavy' : 'light'
  if ((signals.tools ?? 0) > 0 || (signals.retrieved ?? 0) > 2 || signals.chars > 3_000) return 'heavy'
  return 'light'
}

async function monthlyTokens(db: Db, orgId: string): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS n FROM ai_runs
    WHERE org_id = ? AND created_at >= date_trunc('month', now())`, orgId)
  return row?.n ?? 0
}

export class AiUnavailable extends HttpError {
  constructor(message: string) { super(503, 'ai_unavailable', message) }
}

export interface Generated { response: ModelResponse; provider: ModelProvider; model: string; tier: Tier }

/**
 * One model call with fallback across providers. `build` receives the model and whether its provider is
 * external, and returns the request (the caller pseudonymises for external providers).
 */
export async function generate(app: FastifyInstance, access: AiAccess, orgId: string, run: Run, tier: Tier,
  build: (model: string, external: boolean) => ModelRequest): Promise<Generated> {
  if (!access.allowed) throw new AiUnavailable(access.reason ?? 'IA indisponible.')
  const limit = access.settings.monthly_token_limit
  if (limit && await monthlyTokens(app.deps.db, orgId) >= limit) {
    await run.step('budget', 'plafond mensuel', 'blocked', { limit })
    throw new AiUnavailable('Le plafond mensuel de consommation IA de votre organisation est atteint. Contactez votre administrateur.')
  }
  const available = serverProviders(app)
  let lastError: unknown = null
  for (const id of access.order) {
    const candidate = available[id]!
    const model = candidate.models[tier]
    const started = Date.now()
    try {
      const response = await candidate.provider.generate(build(model, candidate.provider.external))
      run.addUsage(response.model, id, response.usage)
      await run.step('model', `${id}/${response.model}`, 'ok', {
        tier, input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens,
        cache_read_tokens: response.usage.cacheReadTokens, stop: response.stopReason,
      }, Date.now() - started)
      return { response, provider: candidate.provider, model: response.model, tier }
    } catch (error) {
      lastError = error
      const kind = error instanceof ProviderError ? error.kind : 'unavailable'
      await run.step('fallback', `${id}/${model}`, 'error', { kind, message: error instanceof Error ? error.message : String(error) }, Date.now() - started)
      if (!(error instanceof ProviderError)) app.log.error({ err: String(error), provider: id }, 'model provider failed')
    }
  }
  const refused = lastError instanceof ProviderError && lastError.kind === 'refusal'
  throw new AiUnavailable(refused
    ? 'Le modèle a décliné cette demande. Reformulez-la ou contactez le support.'
    : 'Aucun modèle de langage ne répond pour le moment. Réessayez dans quelques minutes.')
}
