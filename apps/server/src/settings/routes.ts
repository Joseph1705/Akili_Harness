/**
 * Administration › Clés API et services, for the platform operators only (AKILI_PLATFORM_ADMINS; a 404 for anyone
 * else): see each service and where its values come from, set or remove values. A secret never leaves the server;
 * every change is written to the audit log (names only) and announced by e-mail to every operator, so a stolen
 * session cannot quietly swap, say, the payment key.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.js'
import { platformAdminOf } from '../auth/context.js'
import type { Config } from '../config.js'
import { badRequest, notFound } from '../errors.js'
import { SASPAY_LIVE, SASPAY_SANDBOX, SECTIONS, normalizeChanges, type SectionId, type SettingSection } from './catalog.js'
import { loadStored, reloadSettings, resolveSettings, sealSetting, storedProblems, type Stored } from './store.js'

const Params = z.object({ section: z.string().max(40) })
const Body = z.object({ values: z.record(z.string().max(80), z.string().max(4000).nullable()) }).strict()

export function sectionOf(id: string): SettingSection {
  const section = SECTIONS.find(s => s.id === id)
  if (!section) throw notFound('Réglage')
  return section
}

/** The last 4 characters of a secret long enough to keep it secret, so the operator recognises it. */
const hintOf = (value: string | undefined) => value && value.length >= 16 ? `…${value.slice(-4)}` : null

const ACTIVE: Record<SectionId, (c: Config) => boolean> = {
  anthropic: c => Boolean(c.ai.anthropic),
  deepseek: c => Boolean(c.ai.deepseek),
  other_model: c => Boolean(c.ai.local),
  embeddings: c => Boolean(c.ai.embeddings),
  saspay: c => Boolean(c.saspay),
  google: c => Boolean(c.connectors.google),
  whatsapp: c => Boolean(c.connectors.whatsapp),
  platform: () => true,
}

function statusText(c: Config, id: SectionId): string {
  const models = (m: { light: string; heavy: string }) => `léger : ${m.light} · lourd : ${m.heavy}`
  switch (id) {
    case 'anthropic': return c.ai.anthropic ? `Actif · ${models(c.ai.anthropic.models)}` : 'Non configuré'
    case 'deepseek': return c.ai.deepseek ? `Actif · ${models(c.ai.deepseek.models)}` : 'Non configuré'
    case 'other_model': return c.ai.local
      ? `Actif · ${c.ai.local.external ? 'fournisseur externe (consentement et pseudonymisation)' : 'sur notre réseau'} · ${models(c.ai.local.models)}`
      : 'Non configuré'
    case 'embeddings': return c.ai.embeddings
      ? `Actif · modèle : ${c.ai.embeddings.model}${c.ai.embeddings.external ? ' · fournisseur externe (consentement requis)' : ''}`
      : 'Non configuré : recherche par mots seulement'
    case 'saspay': {
      if (!c.saspay) return "Non configuré : l'achat en ligne est refusé avec un message clair"
      const mode = c.saspay.baseUrl === SASPAY_SANDBOX ? 'bac à sable (sans argent réel)' : c.saspay.baseUrl === SASPAY_LIVE ? 'argent réel' : c.saspay.baseUrl
      return `Actif · ${mode}${c.saspay.webhookSecret ? '' : ' · sans secret de webhook'}`
    }
    case 'google': return c.connectors.google ? 'Actif : les organisations peuvent connecter leur compte Google' : 'Non configuré'
    case 'whatsapp': return c.connectors.whatsapp ? 'Actif : les organisations peuvent connecter leur numéro' : 'Non configuré'
    case 'platform': return `Nom affiché : ${c.brand}`
  }
}

function urlsOf(c: Config, id: SectionId): Array<{ label: string; value: string }> {
  switch (id) {
    case 'saspay': return [{ label: 'URL du webhook à déclarer chez SasPay', value: `${c.publicOrigin}/api/webhooks/saspay` }]
    case 'google': return [{ label: 'URI de redirection autorisée, à déclarer chez Google', value: `${c.publicOrigin}/api/connectors/google/callback` }]
    case 'whatsapp': return [{ label: "URL de rappel à déclarer chez Meta (avec le jeton de vérification)", value: `${c.publicOrigin}/api/webhooks/whatsapp` }]
    default: return []
  }
}

export function sectionView(config: Config, stored: Stored, section: SettingSection) {
  const problem = storedProblems(config).get(section.id)
  return {
    id: section.id,
    title: section.title,
    description: section.description,
    testable: section.testable,
    status: problem ? 'error' as const : ACTIVE[section.id](config) ? 'on' as const : 'off' as const,
    statusText: problem ? `Valeurs enregistrées ici ignorées : ${problem}` : statusText(config, section.id),
    urls: urlsOf(config, section.id),
    fields: section.fields.map(f => {
      const fromEnv = config.baseEnv[f.key]?.trim() || undefined
      const onScreen = f.key in stored.values || stored.unreadable.includes(f.key)
      const value = f.key in stored.values ? stored.values[f.key] : onScreen ? undefined : fromEnv
      return {
        key: f.key,
        label: f.label,
        kind: f.kind,
        help: f.help ?? null,
        placeholder: f.placeholder ?? null,
        options: f.options ?? null,
        source: onScreen ? 'screen' as const : fromEnv ? 'env' as const : 'none' as const,
        value: f.kind === 'secret' ? null : value ?? null,
        hint: f.kind === 'secret' ? hintOf(value) : null,
        updatedAt: stored.meta[f.key]?.updatedAt ?? null,
        updatedBy: stored.meta[f.key]?.updatedBy ?? null,
      }
    }),
  }
}

async function announce(app: FastifyInstance, actor: string, ip: string, section: SettingSection, set: string[], removed: string[]): Promise<void> {
  const { config, mailer } = app.deps
  if (!mailer.sendMail) return
  const labels = (keys: string[]) => keys.map(k => section.fields.find(f => f.key === k)!.label).join(', ')
  const text = [
    'Bonjour,',
    '',
    `${actor} a modifié le réglage « ${section.title} » le ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (UTC), depuis l'adresse ${ip}.`,
    ...(set.length ? [`Enregistré : ${labels(set)}.`] : []),
    ...(removed.length ? [`Retiré : ${labels(removed)}.`] : []),
    '',
    'Les valeurs ne sont jamais envoyées par e-mail.',
    "Si vous n'êtes pas à l'origine de ce changement : connectez-vous, ouvrez Administration › Clés API et services, et changez les clés concernées chez le fournisseur.",
  ].join('\n')
  for (const to of config.platformAdmins) {
    try {
      await mailer.sendMail({ to, subject: `${config.brand} — réglage modifié : ${section.title}`, text })
    } catch (error) {
      app.log.error({ err: String(error), section: section.id }, 'settings change notice not sent')
    }
  }
}

export async function platformSettingsRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps

  app.get('/', async (request) => {
    platformAdminOf(request, config)
    const stored = await loadStored(db, config)
    return { sections: SECTIONS.map(s => sectionView(config, stored, s)) }
  })

  app.put('/:section', async (request) => {
    const user = platformAdminOf(request, config)
    const section = sectionOf(Params.parse(request.params).section)
    const changes = normalizeChanges(section, Body.parse(request.body).values)
    const before = await loadStored(db, config)
    // Sending back what is already stored changes nothing (and announces nothing).
    for (const [key, value] of [...changes]) {
      if (!before.unreadable.includes(key) && (before.values[key] ?? null) === value) changes.delete(key)
    }
    if (changes.size === 0) return { section: sectionView(config, before, section) }

    // Checked exactly as on start-up, with every other stored value: what is refused here would be ignored there.
    const values = { ...before.values }
    for (const [key, value] of changes) {
      if (value === null) delete values[key]
      else values[key] = value
    }
    const problem = resolveSettings(config, { values, unreadable: before.unreadable.filter(k => !changes.has(k)) }).problems.get(section.id)
    if (problem) throw badRequest(problem)

    await db.tx(async tx => {
      for (const [key, value] of changes) {
        if (value === null) await tx.run('DELETE FROM platform_settings WHERE name = ?', key)
        else await tx.run(`INSERT INTO platform_settings (name, value, updated_by, updated_at) VALUES (?, ?, ?, now())
          ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, key, sealSetting(config, key, value), user.id)
      }
    })
    await reloadSettings(app.deps, message => request.log.warn(message))

    const keys = section.fields.map(f => f.key).filter(k => changes.has(k))
    const set = keys.filter(k => changes.get(k) !== null)
    const removed = keys.filter(k => changes.get(k) === null)
    await audit(db, { orgId: null, userId: user.id }, 'platform.settings_updated', 'platform_settings', section.id, { set, removed })
    await announce(app, user.email, request.ip, section, set, removed)
    return { section: sectionView(config, await loadStored(db, config), section) }
  })
}
