/**
 * Values saved in Administration › Clés API et services: one encrypted row per setting in `platform_settings`, laid
 * over the .env file, then copied into the running server's configuration (every module reads it on each request,
 * so a new key works at once, without a restart).
 */
import type { Config } from '../config.js'
import { isOurNetworkAddress, readServices } from '../config.js'
import type { Db } from '../db.js'
import { openSecret, sealSecret } from '../security/secrets.js'
import { SECTIONS, type SectionId } from './catalog.js'

/** Encryption scope of these rows: no organization id (always a UUID) can take this name. */
const SCOPE = 'platform'
const purpose = (name: string) => `setting:${name}`

export interface Stored {
  /** Decrypted values, by variable name. */
  values: Record<string, string>
  meta: Record<string, { updatedAt: string; updatedBy: string | null }>
  /** Rows that this master key cannot decrypt (a database restored on a server with another key). */
  unreadable: string[]
}

export async function loadStored(db: Db, config: Config): Promise<Stored> {
  const rows = await db.all<{ name: string; value: Buffer; updated_at: string | Date; email: string | null }>(
    'SELECT s.name, s.value, s.updated_at, u.email FROM platform_settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.name')
  const stored: Stored = { values: {}, meta: {}, unreadable: [] }
  for (const row of rows) {
    stored.meta[row.name] = { updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.email }
    try {
      stored.values[row.name] = openSecret<string>(config, SCOPE, purpose(row.name), Buffer.from(row.value))
    } catch {
      stored.unreadable.push(row.name)
    }
  }
  return stored
}

export function sealSetting(config: Config, name: string, value: string): Buffer {
  return sealSecret(config, SCOPE, purpose(name), value)
}

const UNREADABLE = 'Valeurs enregistrées illisibles avec la clé maître de ce serveur (a-t-elle changé ?) : saisissez-les à nouveau.'

/**
 * Rule 5: the .env switches that declare a model "ours" (AKILI_LOCAL_MODEL_EXTERNAL=0, AKILI_EMBEDDINGS_EXTERNAL=0)
 * vouch for the .env address only. An address typed on the screen is judged by itself, like any address without a
 * switch: a public one is an external provider (consent and pseudonymisation). "1" (always external) is stricter: kept.
 */
function judgeScreenAddresses(env: NodeJS.ProcessEnv, screen: Record<string, string>): NodeJS.ProcessEnv {
  const out = { ...env }
  if (screen.AKILI_LOCAL_MODEL_URL && out.AKILI_LOCAL_MODEL_EXTERNAL?.trim() !== '1') delete out.AKILI_LOCAL_MODEL_EXTERNAL
  if (screen.AKILI_EMBEDDINGS_URL && out.AKILI_EMBEDDINGS_EXTERNAL?.trim() !== '1') {
    out.AKILI_EMBEDDINGS_EXTERNAL = isOurNetworkAddress(screen.AKILI_EMBEDDINGS_URL) ? '0' : '1'
  }
  return out
}

/**
 * The variables in effect: the .env file, then the stored values section by section. A section whose stored values
 * are unreadable, or invalid with the rest, is left out (its .env values stay in effect) and its problem returned.
 */
export function resolveSettings(config: Config, stored: Pick<Stored, 'values' | 'unreadable'>): { env: NodeJS.ProcessEnv; problems: Map<SectionId, string> } {
  const production = config.env === 'production'
  const accepted: Record<string, string> = {}
  const problems = new Map<SectionId, string>()
  for (const section of SECTIONS) {
    const keys = section.fields.map(f => f.key)
    if (keys.some(k => stored.unreadable.includes(k))) { problems.set(section.id, UNREADABLE); continue }
    const mine = Object.fromEntries(keys.filter(k => k in stored.values).map(k => [k, stored.values[k]!]))
    if (Object.keys(mine).length === 0) continue
    const screen = { ...accepted, ...mine }
    const env = judgeScreenAddresses({ ...config.baseEnv, ...screen }, screen)
    const problem = section.check?.(env) ?? null
    if (problem) { problems.set(section.id, problem); continue }
    try {
      readServices(env, production)
      Object.assign(accepted, mine)
    } catch {
      problems.set(section.id, 'Valeurs refusées : vérifiez-les.')
    }
  }
  return { env: judgeScreenAddresses({ ...config.baseEnv, ...accepted }, accepted), problems }
}

const loaded = new WeakMap<Config, Map<SectionId, string>>()

/** Problems found with the stored values the last time they were applied, by section. */
export function storedProblems(config: Config): ReadonlyMap<SectionId, string> {
  return loaded.get(config) ?? new Map()
}

/** Read the stored values and apply them to the running configuration. */
export async function reloadSettings(deps: { db: Db; config: Config }, warn?: (message: string) => void): Promise<void> {
  const { config } = deps
  const { env, problems } = resolveSettings(config, await loadStored(deps.db, config))
  Object.assign(config, readServices(env, config.env === 'production'))
  loaded.set(config, problems)
  for (const [section, problem] of problems) warn?.(`platform settings: stored values of "${section}" ignored: ${problem}`)
}
