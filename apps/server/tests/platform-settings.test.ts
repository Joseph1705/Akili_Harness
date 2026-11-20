/**
 * Administration › Clés API et services: the platform operators paste the keys of the services in the browser.
 * Stored encrypted, applied at once without a restart, never shown again, audited and announced by e-mail.
 */
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { AiUnavailable, aiAccess, generate } from '../src/ai/router.js'
import { startRun } from '../src/ai/runs.js'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { drainJobs } from '../src/jobs.js'
import { startFakeOpenAi } from './fakes/llm.js'
import { startFakeGoogle } from './fakes/services.js'
import { as, createTestApp, eventually, login, multipart, onboardedOwner, ORIGIN, type TestContext } from './helpers.js'

const OPS = 'ops@akili.example'
const SANDBOX = 'https://sandbox-api.saspay.me/api/v1'

interface FieldView { key: string; kind: string; source: string; value: string | null; hint: string | null }
interface SectionView { id: string; status: string; statusText: string; urls: Array<{ label: string; value: string }>; fields: FieldView[] }

let t: TestContext | undefined
const restarted: FastifyInstance[] = []
const fakes: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const app of restarted.splice(0)) await app.close()
  for (const fake of fakes.splice(0)) await fake.close()
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
    expect((await owner.call('POST', '/api/platform/settings/google/test', {})).statusCode).toBe(404)
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
      // Invisible or blank characters copied with a key would break every call to the provider.
      ['anthropic', { ANTHROPIC_API_KEY: 'sk-ant-zero​width-000000000' }],
      ['anthropic', { ANTHROPIC_API_KEY: 'sk-ant-no break-0000000000' }],
      ['saspay', { SASPAY_API_KEY: 'sk_test inner space 0000000' }],
      // A key must not travel in clear, nor an address carry a password or reach the cloud metadata service.
      ['other_model', { AKILI_LOCAL_MODEL_URL: 'http://api.openai.com/v1', AKILI_LOCAL_MODEL_HEAVY: 'gpt-test' }],
      ['embeddings', { AKILI_EMBEDDINGS_URL: 'https://user:pass@emb.example.com/v1', AKILI_EMBEDDINGS_MODEL: 'embed-test' }],
      ['embeddings', { AKILI_EMBEDDINGS_URL: 'https://emb.example.com/v1?key=abc', AKILI_EMBEDDINGS_MODEL: 'embed-test' }],
      ['other_model', { AKILI_LOCAL_MODEL_URL: 'http://169.254.169.254/latest', AKILI_LOCAL_MODEL_HEAVY: 'gpt-test' }],
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

    await eventually(async () => t!.mailer.sent.length === 2)
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

  it('saves without waiting for the e-mail server', async () => {
    const ops = await operator()
    t!.mailer.sendMail = () => new Promise(() => {}) // a mail server that never answers
    const res = await ops('PUT', '/api/platform/settings/platform', { values: { AKILI_SUPPORT_EMAIL: 'aide@akili.example' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(t!.config.supportEmail).toBe('aide@akili.example')
  }, 10_000)

  it('judges an address typed here by itself, even when the .env file declares its model "ours" (rule 5)', async () => {
    const ops = await operator({ AKILI_LOCAL_MODEL_EXTERNAL: '0', AKILI_EMBEDDINGS_EXTERNAL: '0' })
    const local = await ops('PUT', '/api/platform/settings/other_model', { values: { AKILI_LOCAL_MODEL_URL: 'https://api.openai.com/v1', AKILI_LOCAL_MODEL_HEAVY: 'gpt-test' } })
    expect(local.statusCode, local.body).toBe(200)
    expect(t!.config.ai.local?.external).toBe(true)
    expect(local.json().section.statusText).toContain('fournisseur externe')

    expect((await ops('PUT', '/api/platform/settings/embeddings', { values: { AKILI_EMBEDDINGS_URL: 'https://api.openai.com/v1', AKILI_EMBEDDINGS_MODEL: 'embed-test' } })).statusCode).toBe(200)
    expect(t!.config.ai.embeddings?.external).toBe(true)
    // A service next to ours (a one-word host name, a container) is ours, as with the .env file.
    expect((await ops('PUT', '/api/platform/settings/embeddings', { values: { AKILI_EMBEDDINGS_URL: 'http://embeddings:8080/v1' } })).statusCode).toBe(200)
    expect(t!.config.ai.embeddings?.external).toBe(false)

    const next = await restart(t!.config.baseEnv)
    expect(next.config.ai.local?.external).toBe(true)
  })

  it('limits saves, since each one is e-mailed to every operator', async () => {
    const ops = await operator()
    for (let i = 0; i < 30; i++) {
      expect((await ops('PUT', '/api/platform/settings/platform', { values: { AKILI_BRAND_NAME: `Nom ${i}` } })).statusCode).toBe(200)
    }
    expect((await ops('PUT', '/api/platform/settings/platform', { values: { AKILI_BRAND_NAME: 'Encore' } })).statusCode).toBe(429)
    expect(t!.config.brand).toBe('Nom 29')
  })
})

describe('a change while work is under way', () => {
  const AI_ON = { enabled: true, mode: 'external', use_for_extraction: true, use_for_chat: true, whatsapp_drafts: false, monthly_token_limit: null }
  const request = (model: string) => ({ model, system: 'Test.', maxTokens: 16, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Bonjour' }] }] })

  it('stops a model call whose provider was removed meanwhile, with a clear error', async () => {
    const fake = await startFakeOpenAi()
    fakes.push(fake)
    const ops = await operator({ DEEPSEEK_BASE_URL: fake.url })
    expect((await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: 'sk-deepseek-screen-only-000001' } })).statusCode).toBe(200)
    const owner = await onboardedOwner(t!, 'owner@example.cd')
    await owner.call('PUT', '/api/ai/settings', AI_ON)
    await owner.call('POST', '/api/orgs/current/consents', { type: 'external_model', granted: true })
    const access = await aiAccess(t!.app, owner.orgId)
    expect(access.order).toEqual(['deepseek'])

    expect((await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: null } })).statusCode).toBe(200)
    const run = await startRun(t!.db, { orgId: owner.orgId, purpose: 'chat' })
    await expect(generate(t!.app, access, owner.orgId, run, 'light', request)).rejects.toBeInstanceOf(AiUnavailable)
    expect(fake.requests).toEqual([])
  })

  it('never sends a call to a provider that became external meanwhile, for an organization that did not consent', async () => {
    const fake = await startFakeOpenAi()
    fakes.push(fake)
    const ops = await operator({ AKILI_LOCAL_MODEL_URL: fake.url, AKILI_LOCAL_MODEL_HEAVY: 'local-model' })
    const owner = await onboardedOwner(t!, 'owner@example.cd')
    await owner.call('PUT', '/api/ai/settings', { ...AI_ON, mode: 'local' })
    const access = await aiAccess(t!.app, owner.orgId)
    expect(access).toMatchObject({ allowed: true, externalConsent: false, order: ['local'] })

    expect((await ops('PUT', '/api/platform/settings/other_model', { values: { AKILI_LOCAL_MODEL_URL: 'https://models.example.com/v1' } })).statusCode).toBe(200)
    const reached: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('models.example.com')) { reached.push(url); throw new TypeError('blocked by the test') }
      return realFetch(input, init)
    }) as typeof fetch
    try {
      const run = await startRun(t!.db, { orgId: owner.orgId, purpose: 'chat' })
      await expect(generate(t!.app, access, owner.orgId, run, 'light', request)).rejects.toBeInstanceOf(AiUnavailable)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(reached).toEqual([])
  })

  it('embeds a whole document with the service it started with', async () => {
    const first = await startFakeOpenAi()
    const second = await startFakeOpenAi()
    fakes.push(first, second)
    t = await createTestApp({ AKILI_PLATFORM_ADMINS: OPS, AKILI_EMBEDDINGS_URL: first.url, AKILI_EMBEDDINGS_MODEL: 'embed-test', AKILI_EMBEDDINGS_EXTERNAL: '1' })
    const owner = await onboardedOwner(t, 'owner@example.cd')
    await owner.call('PUT', '/api/ai/settings', AI_ON)
    await owner.call('POST', '/api/orgs/current/consents', { type: 'external_model', granted: true })
    // An operator points the embeddings elsewhere while the first batch of this document is being embedded.
    first.onEmbeddings = () => { t!.config.ai = { ...t!.config.ai, embeddings: { ...t!.config.ai.embeddings!, baseUrl: second.url } } }
    const text = Array.from({ length: 90 }, (_, i) => `SECTION ${i + 1}\n${'Le chantier fictif avance selon le planning prévu. '.repeat(17)}`).join('\n\n')
    const body = multipart({}, { field: 'file', filename: 'long.txt', bytes: Buffer.from(text) })
    const res = await t.app.inject({ method: 'POST', url: '/api/knowledge', headers: { origin: ORIGIN, cookie: owner.cookie, ...body.headers }, payload: body.payload })
    expect(res.statusCode, res.body).toBe(200)
    await drainJobs(t.app)
    expect(first.requests.filter(r => r.path === '/embeddings').length).toBeGreaterThan(1)
    expect(second.requests).toEqual([])
  })
})

describe('testing a service from the screen', () => {
  const models = { AKILI_DEEPSEEK_MODEL_LIGHT: 'm-light', AKILI_DEEPSEEK_MODEL_HEAVY: 'm-heavy' }

  it('tries the light and the heavy model with the key just saved', async () => {
    const fake = await startFakeOpenAi()
    fakes.push(fake)
    const ops = await operator({ DEEPSEEK_BASE_URL: fake.url })
    expect((await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: 'sk-deepseek-first-key-0000001', ...models } })).statusCode).toBe(200)

    const first = await ops('POST', '/api/platform/settings/deepseek/test', {})
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().ok).toBe(true)
    expect(first.json().message).toContain('m-light')
    expect(first.json().message).toContain('m-heavy')
    expect(fake.requests.map(r => r.body.model)).toEqual(['m-light', 'm-heavy'])
    expect(fake.requests.map(r => r.headers.authorization)).toEqual(['Bearer sk-deepseek-first-key-0000001', 'Bearer sk-deepseek-first-key-0000001'])

    // A new key replaces the old one in the model clients at once.
    expect((await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: 'sk-deepseek-second-key-000002' } })).statusCode).toBe(200)
    fake.requests.length = 0
    expect((await ops('POST', '/api/platform/settings/deepseek/test', {})).json().ok).toBe(true)
    expect(fake.requests.map(r => r.headers.authorization)).toEqual(['Bearer sk-deepseek-second-key-000002', 'Bearer sk-deepseek-second-key-000002'])
    expect(await t!.db.all("SELECT target_id, detail FROM audit_log WHERE action = 'platform.settings_tested'")).toHaveLength(2)
  })

  it('says in plain words when the key or a model name is refused', async () => {
    const fake = await startFakeOpenAi()
    fakes.push(fake)
    const ops = await operator({ DEEPSEEK_BASE_URL: fake.url })
    await ops('PUT', '/api/platform/settings/deepseek', { values: { DEEPSEEK_API_KEY: 'sk-deepseek-refused-key-00001', ...models } })

    fake.chat = () => ({ status: 401 })
    const refused = (await ops('POST', '/api/platform/settings/deepseek/test', {})).json()
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/clé refusée/i)

    fake.chat = body => body.model === 'm-heavy' ? { status: 404 } : { content: 'OK' }
    const unknown = (await ops('POST', '/api/platform/settings/deepseek/test', {})).json()
    expect(unknown.ok).toBe(false)
    expect(unknown.message).toContain('m-heavy')
    expect(unknown.message).not.toContain('m-light')
  })

  it('points at the address too when a typed address may be wrong', async () => {
    const fake = await startFakeOpenAi()
    fakes.push(fake)
    const ops = await operator()
    // A common mistake: pasting the full endpoint instead of the base address.
    await ops('PUT', '/api/platform/settings/other_model', { values: { AKILI_LOCAL_MODEL_URL: `${fake.url}/chat/completions`, AKILI_LOCAL_MODEL_HEAVY: 'gpt-test' } })
    const res = (await ops('POST', '/api/platform/settings/other_model/test', {})).json()
    expect(res.ok).toBe(false)
    expect(res.message).toContain("l'adresse")
  })

  it('checks the Google client ID and secret', async () => {
    const google = await startFakeGoogle()
    fakes.push(google)
    const ops = await operator({ GOOGLE_TOKEN_URL: `${google.url}/token` })
    await ops('PUT', '/api/platform/settings/google', { values: { GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret' } })
    expect((await ops('POST', '/api/platform/settings/google/test', {})).json()).toMatchObject({ ok: true })

    await ops('PUT', '/api/platform/settings/google', { values: { GOOGLE_CLIENT_SECRET: 'not-the-google-secret' } })
    expect((await ops('POST', '/api/platform/settings/google/test', {})).json()).toMatchObject({ ok: false })
  })

  it('checks the embeddings service', async () => {
    const fake = await startFakeOpenAi()
    fakes.push(fake)
    const ops = await operator()
    await ops('PUT', '/api/platform/settings/embeddings', { values: { AKILI_EMBEDDINGS_URL: fake.url, AKILI_EMBEDDINGS_MODEL: 'embed-test' } })
    const res = (await ops('POST', '/api/platform/settings/embeddings/test', {})).json()
    expect(res.ok).toBe(true)
    expect(res.message).toContain('64')
    expect(fake.requests[0]).toMatchObject({ path: '/embeddings', body: { model: 'embed-test' } })
  })

  it('refuses to test a service that is not set or has nothing to test, and limits the number of tests', async () => {
    const ops = await operator()
    expect((await ops('POST', '/api/platform/settings/saspay/test', {})).statusCode).toBe(404)
    for (let i = 0; i < 10; i++) expect((await ops('POST', '/api/platform/settings/anthropic/test', {})).statusCode).toBe(409)
    expect((await ops('POST', '/api/platform/settings/anthropic/test', {})).statusCode).toBe(429)
  })
})
