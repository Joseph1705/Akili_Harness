/**
 * The "Tester" buttons of Administration › Clés API et services: one small real call with the values in effect, so a
 * wrong key or model name shows at once instead of on a customer's first document. Asked by an operator, with no
 * customer data in it (rule 5); the answer is a sentence in French, never a raw error.
 */
import type { FastifyInstance } from 'fastify'
import { serverProviders } from '../ai/router.js'
import { embed } from '../ai/providers/openai-compatible.js'
import { ProviderError, type ProviderId } from '../ai/types.js'
import type { Config } from '../config.js'
import { HttpError } from '../errors.js'

export interface ProbeResult { ok: boolean; message: string }

const notSet = () => new HttpError(409, 'not_configured', "Ce service n'est pas encore réglé : enregistrez d'abord sa clé, puis testez-le.")

/** `typedAddress`: the address was typed by the operator too (other model, embeddings), so it may be the mistake. */
function why(error: unknown, model: string, typedAddress: boolean): string {
  if (!(error instanceof ProviderError)) return 'erreur inattendue'
  switch (error.kind) {
    case 'auth': return 'clé refusée par le fournisseur'
    case 'invalid': return `demande refusée${error.status ? ` (HTTP ${error.status})` : ''} : `
      + (typedAddress ? `vérifiez le nom du modèle « ${model} » et l'adresse de l'API (adresse de base, finissant en général par /v1)` : `le nom du modèle « ${model} » est-il exact ?`)
    case 'rate_limit': return 'limite atteinte ou crédit épuisé chez le fournisseur'
    case 'refusal': return 'le modèle a décliné la question de test'
    case 'unavailable': return 'fournisseur injoignable'
  }
}

/** The light model, then the heavy one (once when they are the same). A model that declines still proves the key. */
export async function probeModels(app: FastifyInstance, id: ProviderId): Promise<ProbeResult> {
  const candidate = serverProviders(app)[id]
  if (!candidate) throw notSet()
  const { light, heavy } = candidate.models
  const tiers: Array<[string, string]> = light === heavy ? [['', heavy]] : [['léger ', light], ['lourd ', heavy]]
  const answered: string[] = []
  for (const [tier, model] of tiers) {
    const started = Date.now()
    try {
      await candidate.provider.generate({
        model, system: 'Test de connexion.', maxTokens: 32,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Réponds seulement : OK' }] }],
      })
    } catch (error) {
      if (!(error instanceof ProviderError && error.kind === 'refusal')) {
        return { ok: false, message: `Échec avec le modèle ${tier}« ${model} » : ${why(error, model, id === 'local')}.` }
      }
    }
    answered.push(`${tier}« ${model} » en ${Date.now() - started} ms`)
  }
  return { ok: true, message: `Le fournisseur répond : ${answered.join(', ')}.` }
}

export async function probeEmbeddings(config: Config): Promise<ProbeResult> {
  const cfg = config.ai.embeddings
  if (!cfg) throw notSet()
  const started = Date.now()
  try {
    const [vector] = await embed(cfg, ['Test de connexion'])
    return { ok: true, message: `Le service répond : vecteurs de ${vector?.length ?? 0} dimensions, en ${Date.now() - started} ms.` }
  } catch (error) {
    return { ok: false, message: `Échec avec le modèle « ${cfg.model} » : ${why(error, cfg.model, true)}.` }
  }
}

/**
 * Google checks the client before the code: exchanging a made-up code answers `invalid_grant` when the client ID and
 * secret are right, `invalid_client` when they are not. Nothing is authorized by this call.
 */
export async function probeGoogle(config: Config): Promise<ProbeResult> {
  const cfg = config.connectors.google
  if (!cfg) throw notSet()
  let res: Response
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code',
        code: 'akili-connection-test', redirect_uri: `${config.publicOrigin}/api/connectors/google/callback`,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    })
  } catch {
    return { ok: false, message: 'Google est injoignable depuis le serveur. Réessayez dans quelques minutes.' }
  }
  const body = await res.json().catch(() => ({})) as { error?: unknown }
  const error = typeof body.error === 'string' ? body.error : ''
  if (error === 'invalid_grant') return { ok: true, message: "Google reconnaît l'ID client et le code secret. Vérifiez aussi que l'URI de redirection est déclarée dans la console Google." }
  if (error === 'invalid_client' || res.status === 401) return { ok: false, message: "Google refuse l'ID client ou le code secret : recopiez-les depuis la console Google." }
  if (error === 'redirect_uri_mismatch') return { ok: false, message: "Google reconnaît le client, mais l'URI de redirection n'est pas déclarée : ajoutez-la dans la console Google." }
  return { ok: false, message: `Réponse inattendue de Google (HTTP ${res.status}${error ? `, ${error.slice(0, 60)}` : ''}).` }
}
