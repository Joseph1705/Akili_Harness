/**
 * Administration › Clés API et services: the platform operators paste the keys of the services in the browser.
 * Stored encrypted, applied at once without a restart, never shown again, audited and announced by e-mail.
 */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { as, createTestApp, login, onboardedOwner, ORIGIN, type TestContext } from './helpers.js'

const OPS = 'ops@akili.example'
const SANDBOX = 'https://sandbox-api.saspay.me/api/v1'

interface FieldView { key: string; kind: string; source: string; value: string | null; hint: string | null }
interface SectionView { id: string; status: string; statusText: string; urls: Array<{ label: string; value: string }>; fields: FieldView[] }

let t: TestContext | undefined
const restarted: FastifyInstance[] = []
afterEach(async () => {
  for (const app of restarted.splice(0)) await app.close()
  await t?.close()
  t = undefined
})

/** A test server whose platform operator is logged in. */
async function operator(env: Record<string, string> = {}) {
  t = await createTestApp({ AKILI_PLATFORM_ADMINS: OPS, ...env })
  return as(t, await login(t, OPS))
}

/** The same database read by a new server process started with `env` (a restart, or another .env file). */
async function restart(env: NodeJS.ProcessEnv) {
  const config = loadConfig(env)
  const app = await buildApp({ config, db: t!.db, mailer: t!.mailer })
  await app.ready()
  restarted.push(app)
  const ctx = { ...t!, app, config }
  return { config, ops: as(ctx, await login(ctx, OPS)) }
}

const sectionOf = (body: { sections: SectionView[] }, id: string) => body.sections.find(s => s.id === id)!
const fieldOf = (section: SectionView, key: string) => section.fields.find(f => f.key === key)!

describe('service keys from the interface', () => {
  it('is invisible to anyone who is not a platform operator', async () => {
    t = await createTestApp({ AKILI_PLATFORM_ADMINS: OPS })
    const owner = await onboardedOwner(t, 'owner@example.cd')
    expect((await owner.call('GET', '/api/platform/settings')).statusCode).toBe(404)
    expect((await owner.call('PUT', '/api/platform/settings/saspay', { values: { SASPAY_API_KEY: 'sk_test_owner_key_0000000000' } })).statusCode).toBe(404)
    expect(t.config.saspay).toBeUndefined()
  })

  it('lists every service and where each value comes from, never a secret', async () => {
    const ops = await operator({ DEEPSEEK_API_KEY: 'sk-deepseek-from-env-1234567890' })
    const res = await ops('GET', '/api/platform/settings')
    expect(res.statusCode).toBe(200)
    const body = res.json() as { sections: SectionView[] }
    expect(body.sections.map(s => s.id).sort()).toEqual(['anthropic', 'deepseek', 'embeddings', 'google', 'other_model', 'platform', 'saspay', 'whatsapp'])
    expect(fieldOf(sectionOf(body, 'deepseek'), 'DEEPSEEK_API_KEY')).toMatchObject({ kind: 'secret', source: 'env', hint: '…7890', value: null })
    expect(sectionOf(body, 'deepseek').status).toBe('on')
    expect(sectionOf(body, 'anthropic').status).toBe('off')
    expect(res.body).not.toContain('sk-deepseek-from-env')
    expect(sectionOf(body, 'saspay').urls.map(u => u.value)).toContain(`${ORIGIN}/api/webhooks/saspay`)
    expect(sectionOf(body, 'whatsapp').urls.map(u => u.value)).toContain(`${ORIGIN}/api/webhooks/whatsapp`)
    expect(sectionOf(body, 'google').urls.map(u => u.value)).toContain(`${ORIGIN}/api/connectors/google/callback`)
  })

  it('applies a pasted key at once, keeps it encrypted, and still has it after a restart', async () => {
    const ops = await operator()
    const owner = await onboardedOwner(t!, 'owner@example.cd')
    expect((await owner.call('GET', '/api/billing/status')).json().online).toBe(false)

    const res = await ops('PUT', '/api/platform/settings/saspay', { values: { SASPAY_API_KEY: '  sk_test_screen_key_0123456789\n', SASPAY_BASE_URL: SANDBOX } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().section).toMatchObject({ id: 'saspay', status: 'on' })
    expect(t!.config.saspay).toMatchObject({ apiKey: 'sk_test_screen_key_0123456789', baseUrl: SANDBOX })
    expect((await owner.call('GET', '/api/billing/status')).json().online).toBe(true)

    const rows = await t!.db.all<{ name: string; value: Buffer }>('SELECT name, value FROM platform_settings')
    expect(rows.map(r => r.name).sort()).toEqual(['SASPAY_API_KEY', 'SASPAY_BASE_URL'])
    expect(rows.some(r => Buffer.from(r.value).includes('sk_test_screen_key'))).toBe(false)

    const { config } = await restart(t!.config.baseEnv)
    expect(config.saspay).toMatchObject({ apiKey: 'sk_test_screen_key_0123456789', baseUrl: SANDBOX })
  })

  it('shows platform settings to everyone at once', async () => {
    const ops = await operator()
    const res = await ops('PUT', '/api/platform/settings/platform', { values: { AKILI_SUPPORT_EMAIL: 'aide@akili.example', AKILI_BRAND_NAME: 'Totem' } })
    expect(res.statusCode, res.body).toBe(200)
    expect((await t!.app.inject({ method: 'GET', url: '/api/public/config' })).json()).toMatchObject({ supportEmail: 'aide@akili.example', brand: 'Totem' })
  })

  it('lets the screen win over the .env file, and goes back to the file when the value is removed', async () => {
    const ops = await operator({ DEEPSEEK_API_KEY: 'sk-deepseek-from-env-1234567890' })
    const set = await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: 'sk-deepseek-from-screen-0987654321' } })
    expect(set.statusCode, set.body).toBe(200)
    expect(t!.config.ai.deepseek?.apiKey).toBe('sk-deepseek-from-screen-0987654321')
    expect(fieldOf(set.json().section, 'DEEPSEEK_API_KEY')).toMatchObject({ source: 'screen', hint: '…4321' })

    const back = await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: null } })
    expect(back.statusCode, back.body).toBe(200)
    expect(t!.config.ai.deepseek?.apiKey).toBe('sk-deepseek-from-env-1234567890')
    expect(fieldOf(back.json().section, 'DEEPSEEK_API_KEY')).toMatchObject({ source: 'env', hint: '…7890' })
  })

  it('refuses unknown, incomplete or invalid values and keeps the previous ones', async () => {
    const ops = await operator()
    const google = { GOOGLE_CLIENT_ID: 'client-0001.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-secret-0000000000' }
    expect((await ops('PUT', '/api/platform/settings/google', { values: google })).statusCode).toBe(200)

    const refused: Array<[string, Record<string, string | null>]> = [
      ['platform', { AKILI_PLATFORM_ADMINS: 'intrus@example.com' }],
      ['other_model', { AKILI_LOCAL_MODEL_EXTERNAL: '0' }],
      ['deepseek', { SASPAY_API_KEY: 'sk_test_other_section_000000' }],
      ['google', { GOOGLE_CLIENT_SECRET: null }],
      ['whatsapp', { WHATSAPP_APP_SECRET: 'meta-app-secret-0000000000' }],
      ['other_model', { AKILI_LOCAL_MODEL_URL: 'pas une adresse', AKILI_LOCAL_MODEL_HEAVY: 'gpt-test' }],
      ['other_model', { AKILI_LOCAL_MODEL_URL: 'https://api.openai.com/v1' }],
      ['platform', { AKILI_SIGNUP_CREDITS: '-3' }],
      ['platform', { AKILI_SUPPORT_EMAIL: 'pas-un-email' }],
      ['saspay', { SASPAY_BASE_URL: 'https://evil.example/api/v1' }],
      ['anthropic', { ANTHROPIC_API_KEY: 'sk-ant-start\nsk-ant-end-000000' }],
    ]
    for (const [id, values] of refused) {
      const res = await ops('PUT', `/api/platform/settings/${id}`, { values })
      expect(res.statusCode, `${id} ${JSON.stringify(values)}: ${res.body}`).toBe(400)
      expect(typeof res.json().message).toBe('string')
    }
    expect((await ops('PUT', '/api/platform/settings/telegram', { values: {} })).statusCode).toBe(404)

    const names = (await t!.db.all<{ name: string }>('SELECT name FROM platform_settings ORDER BY name')).map(r => r.name)
    expect(names).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
    expect(t!.config.connectors.google).toMatchObject({ clientId: google.GOOGLE_CLIENT_ID, clientSecret: google.GOOGLE_CLIENT_SECRET })
    expect(t!.config.platformAdmins).toEqual([OPS])
    expect(t!.config.ai.local).toBeUndefined()
    expect(t!.config.saspay).toBeUndefined()
  })

  it('writes nothing, audits nothing and sends nothing when nothing changes', async () => {
    const ops = await operator()
    const res = await ops('PUT', '/api/platform/settings/saspay', { values: {} })
    expect(res.statusCode, res.body).toBe(200)
    expect(await t!.db.all('SELECT name FROM platform_settings')).toEqual([])
    expect(await t!.db.all("SELECT id FROM audit_log WHERE action = 'platform.settings_updated'")).toEqual([])
    expect(t!.mailer.sent).toEqual([])
  })

  it('audits every change and e-mails every operator, never with the value', async () => {
    const ops = await operator({ AKILI_PLATFORM_ADMINS: `${OPS}, associe@akili.example` })
    const res = await ops('PUT', '/api/platform/settings/saspay', { values: { SASPAY_API_KEY: 'sk_live_secret_value_0123456789', SASPAY_WEBHOOK_SECRET: 'whsec_secret_value_0123456789' } })
    expect(res.statusCode, res.body).toBe(200)

    const entries = await t!.db.all<{ org_id: string | null; target_id: string; detail: unknown }>(
      "SELECT org_id, target_id, detail FROM audit_log WHERE action = 'platform.settings_updated'")
    expect(entries).toEqual([{ org_id: null, target_id: 'saspay', detail: { set: ['SASPAY_API_KEY', 'SASPAY_WEBHOOK_SECRET'], removed: [] } }])

    expect(t!.mailer.sent.map(m => m.to).sort()).toEqual(['associe@akili.example', OPS])
    for (const mail of t!.mailer.sent) {
      expect(mail.text).toContain(OPS)
      expect(`${mail.subject}\n${mail.text}`).not.toContain('secret_value')
    }
  })

  it('still starts when a stored value no longer fits the .env file, and says so', async () => {
    const ops = await operator({ AKILI_LOCAL_MODEL_HEAVY: 'llama-local-heavy' })
    const res = await ops('PUT', '/api/platform/settings/other_model', { values: { AKILI_LOCAL_MODEL_URL: 'http://ollama:11434/v1' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(t!.config.ai.local).toMatchObject({ baseUrl: 'http://ollama:11434/v1', models: { heavy: 'llama-local-heavy' } })

    // The model name was in the .env file, and someone removed it: the stored address alone is not a valid setting.
    const { AKILI_LOCAL_MODEL_HEAVY: _removed, ...env } = t!.config.baseEnv
    const next = await restart(env)
    expect(next.config.ai.local).toBeUndefined()
    const body = (await next.ops('GET', '/api/platform/settings')).json() as { sections: SectionView[] }
    expect(sectionOf(body, 'other_model').status).toBe('error')
    expect(sectionOf(body, 'saspay').status).toBe('off')
  })

  it('still starts when stored values cannot be read with this master key, and says so', async () => {
    const ops = await operator()
    expect((await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: 'sk-deepseek-from-screen-0987654321' } })).statusCode).toBe(200)

    const next = await restart({ ...t!.config.baseEnv, AKILI_MASTER_KEY: randomBytes(32).toString('base64') })
    expect(next.config.ai.deepseek).toBeUndefined()
    const body = (await next.ops('GET', '/api/platform/settings')).json() as { sections: SectionView[] }
    expect(sectionOf(body, 'deepseek').status).toBe('error')
  })
})
