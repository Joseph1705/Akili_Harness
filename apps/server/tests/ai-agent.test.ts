import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { drainJobs } from '../src/jobs.js'
import { as, createTestApp, login, readyOrg, type TestContext } from './helpers.js'
import { leaked, startFakeAnthropic, startFakeOpenAi, type FakeAnthropic, type FakeOpenAi } from './fakes/llm.js'

let t: TestContext | undefined
let claude: FakeAnthropic | undefined
let deepseek: FakeOpenAi | undefined
afterEach(async () => { await t?.close(); await claude?.close(); await deepseek?.close(); t = undefined; claude = undefined; deepseek = undefined })

type Org = Awaited<ReturnType<typeof readyOrg>>
const SETTINGS = { enabled: true, mode: 'external', use_for_extraction: true, use_for_chat: true, whatsapp_drafts: false, monthly_token_limit: null as number | null }

/** Identifiers of the fictitious organization and clients: none may reach a model provider. */
const IDENTIFIERS = ['Kibala', 'Tshala', 'Kalembe', 'Lualaba', 'A1234567X', 'A0987654K', 'B2345678M', 'CD/LSH/RCCM/21-B-01234', 'owner@example.cd', 'comptabilite@tshala-logistique.example']

async function setup(env: Record<string, string> = {}) {
  claude = await startFakeAnthropic()
  deepseek = await startFakeOpenAi()
  t = await createTestApp({ ANTHROPIC_API_KEY: 'sk-ant-test-key-0000000000', ANTHROPIC_BASE_URL: claude.url, DEEPSEEK_API_KEY: 'sk-deepseek-test-00000000', DEEPSEEK_BASE_URL: deepseek.url, ...env })
  const o = await readyOrg(t)
  const session = (await o.call('POST', '/api/sessions', { title: 'Questions', agentId: o.agent.id })).json().session.id as string
  const ask = (text: string, call = o.call) => call('POST', `/api/sessions/${session}/messages`, { text })
  return { o, session, ask }
}

async function enable(o: Org, consent = true, settings: Partial<typeof SETTINGS> = {}) {
  expect((await o.call('PUT', '/api/ai/settings', { ...SETTINGS, ...settings })).statusCode).toBe(200)
  if (consent) await o.call('POST', '/api/orgs/current/consents', { type: 'external_model', granted: true })
}

describe('rule 5: nothing leaves without activation and consent', () => {
  it('stays silent until AI is enabled, then needs the external-provider consent', async () => {
    const { o, ask } = await setup()
    expect((await ask('Quelles factures sont impayées ?')).json().reply.text).toMatch(/désactivée/)
    await enable(o, false)
    expect((await ask('Quelles factures sont impayées ?')).json().reply.text).toMatch(/consentement/)
    expect(claude!.requests).toHaveLength(0)
    expect(deepseek!.requests).toHaveLength(0)
  })

  it('in local mode uses only the model on our server, even with consent', async () => {
    const local = await startFakeOpenAi()
    try {
      const { o, ask } = await setup({ AKILI_LOCAL_MODEL_URL: local.url, AKILI_LOCAL_MODEL_HEAVY: 'llama-local' })
      local.chat = () => ({ content: 'Réponse du modèle local.' })
      await enable(o, true, { mode: 'local' })
      expect((await ask('Bonjour')).json().reply.text).toBe('Réponse du modèle local.')
      expect(local.requests).toHaveLength(1)
      expect(claude!.requests).toHaveLength(0)
      expect(deepseek!.requests).toHaveLength(0)
    } finally { await local.close() }
  })
})

describe('agent execution', () => {
  it('sends the active prompt version and pseudonymised data only, and restores the names in the answer', async () => {
    const { o, ask } = await setup()
    await enable(o)
    await o.call('POST', `/api/agents/${o.agent.id}/prompts`, {
      identity: "Tu es l'assistant comptable VERSION-DEUX de l'équipe.", instructions: 'Réponds aux questions sur les factures et les clients.',
      style: 'Très bref.', restrictions: 'Jamais de conseil fiscal.',
    })
    claude!.fallback = (body) => {
      const sent = JSON.stringify(body)
      const token = /\[CLIENT_\d+\]/.exec(sent)?.[0] ?? '[CLIENT_?]'
      return { text: `Le client ${token} vous doit de l'argent.` }
    }
    const reply = (await ask('Où en est Tshala Logistique SARL (NIF A0987654K, comptabilite@tshala-logistique.example) ?')).json().reply
    const request = claude!.requests[0]!.body
    // The organization's active version is what the model receives, after the platform rules.
    const system = JSON.stringify(request.system)
    expect(system).toContain('VERSION-DEUX')
    expect(system).toContain('Règles de la plateforme')
    expect(system.indexOf('Règles de la plateforme')).toBeLessThan(system.indexOf('VERSION-DEUX'))
    expect(request.model).toBe('claude-opus-5-5') // tools are offered: the heavy model
    expect(leaked(claude!.requests, IDENTIFIERS)).toEqual([])
    expect(reply.text).toBe("Le client Tshala Logistique SARL vous doit de l'argent.")
    // Recorded in the run, with the prompt version and tokens; the logs hold pseudonymised text only.
    const runs = (await o.call('GET', '/api/ai/runs?purpose=chat')).json().runs
    expect(runs[0]).toMatchObject({ status: 'ok', provider: 'anthropic', prompt_version: 1, input_tokens: 120, output_tokens: 30 })
    const detail = (await o.call('GET', `/api/ai/runs/${runs[0].id}`)).json()
    expect(detail.run.request_excerpt).not.toMatch(/Tshala|A0987654K/)
    expect(detail.steps.map((s: { kind: string }) => s.kind)).toEqual(expect.arrayContaining(['retrieval', 'model']))
  })

  it('keeps every prompt version, applies the one that is active, and never edits a version', async () => {
    const { o, ask } = await setup()
    await enable(o)
    const v1 = (await o.call('POST', `/api/agents/${o.agent.id}/prompts`, { identity: 'Identité PREMIERE version.', instructions: 'Objectifs de la version un.', style: 'Bref.', restrictions: '' })).json().version
    await o.call('POST', `/api/agents/${o.agent.id}/prompts`, { identity: 'Identité SECONDE version.', instructions: 'Objectifs de la version deux.', style: 'Bref.', restrictions: '' })
    await ask('Bonjour')
    expect(JSON.stringify(claude!.requests.at(-1)!.body.system)).toContain('SECONDE')
    await o.call('POST', `/api/agents/${o.agent.id}/prompts/${v1.id}/activate`)
    await ask('Bonjour encore')
    expect(JSON.stringify(claude!.requests.at(-1)!.body.system)).toContain('PREMIERE')
    const listed = (await o.call('GET', `/api/agents/${o.agent.id}/prompts`)).json()
    expect(listed.versions.map((v: { version: number }) => v.version)).toEqual([2, 1])
    expect(listed.activeId).toBe(v1.id)
    await expect(t!.db.run("UPDATE agent_prompts SET identity = 'piraté'")).rejects.toThrow(/append-only/)
  })

  it('retrieves knowledge before answering, cites it, and keeps it inside the organization', async () => {
    const { o, ask } = await setup()
    await enable(o)
    const doc = 'PROCEDURE DE RELANCE\nLes factures impayées sont relancées à J+15 par e-mail, puis à J+30 par téléphone au service comptable du client.\nAu-delà de 60 jours, le dossier est transmis au gérant.'
    const up = await uploadKnowledge(o, 'procedure-relance.txt', doc)
    expect(up.statusCode, up.body).toBe(200)
    await drainJobs(t!.app)
    const docs = (await o.call('GET', '/api/knowledge')).json().documents
    expect(docs[0]).toMatchObject({ status: 'ready', chunks: 1 })
    claude!.fallback = () => ({ text: 'Une facture impayée est relancée à J+15 par e-mail [1].' })
    const reply = (await ask('Quand relancer une facture impayée ?')).json().reply
    expect(JSON.stringify(claude!.requests.at(-1)!.body.messages)).toContain('<connaissance source=\\"1\\"')
    expect(reply.items).toEqual([{ label: '[1]', value: 'procedure relance — PROCEDURE DE RELANCE' }])
    // Another organization finds nothing.
    const other = await readyOrg(t!, 'autre@example.cd')
    expect((await other.call('POST', '/api/knowledge/search', { query: 'relance facture impayée' })).json().sources).toEqual([])
    expect((await o.call('POST', '/api/knowledge/search', { query: 'relance facture impayée' })).json().sources).toHaveLength(1)
    // Update (new version) then delete.
    const replaced = await uploadKnowledge(o, 'procedure-relance.txt', `${doc}\nNouvelle règle : relance à J+10.`, { replaceId: docs[0].id })
    expect(replaced.statusCode).toBe(200)
    await drainJobs(t!.app)
    expect((await o.call('GET', '/api/knowledge')).json().documents[0]).toMatchObject({ version: 2, status: 'ready' })
    expect((await o.call('DELETE', `/api/knowledge/${docs[0].id}`)).statusCode).toBe(200)
    expect((await o.call('POST', '/api/knowledge/search', { query: 'relance facture' })).json().sources).toEqual([])
  })

  it('uses a read tool, and turns an outbound action into an approval request instead of doing it', async () => {
    const { o, ask, session } = await setup()
    await enable(o)
    await o.call('POST', '/api/invoices', {
      client: { name: 'Nyota Négoce SARL', vat_applicable: true }, issue_date: new Date().toISOString().slice(0, 10),
      due_date: new Date().toISOString().slice(0, 10), currency: 'USD', lines: [{ description: 'Audit', quantity: '1', unit_price: '500' }], vat_rate_bp: 1600,
    }, { 'idempotency-key': randomUUID() })
    claude!.queue.push({ tool: { name: 'lister_factures', input: { statut: 'draft' } } }, { text: 'Vous avez une facture à valider.' })
    const reply = (await ask('Quelles factures dois-je valider ?')).json().reply
    expect(reply.text).toBe('Vous avez une facture à valider.')
    const toolResult = JSON.stringify(claude!.requests[1]!.body.messages)
    expect(toolResult).toContain('resultat_outil')
    expect(toolResult).toContain('580,00 USD')
    expect(toolResult).not.toContain('Nyota') // the tool result is pseudonymised on its way out

    // No Google connection: e-mail tools are not even offered to the model.
    const offered = (claude!.requests[0]!.body.tools as Array<{ name: string }>).map(x => x.name)
    expect(offered).toEqual(expect.arrayContaining(['lister_factures', 'solde_credits', 'rechercher_connaissances']))
    expect(offered).not.toContain('proposer_email')
    const runs = (await o.call('GET', '/api/ai/runs')).json().runs
    expect(runs[0].steps).toBeGreaterThanOrEqual(3)
    expect(session).toBeTruthy()
  })

  it('falls back to the next provider when one fails or declines, and records why', async () => {
    const { o, ask } = await setup()
    await enable(o)
    claude!.queue.push({ status: 500 }, { status: 500 }) // the SDK retries once
    deepseek!.chat = () => ({ content: 'Réponse via DeepSeek.' })
    expect((await ask('Bonjour')).json().reply.text).toBe('Réponse via DeepSeek.')
    const run = (await o.call('GET', '/api/ai/runs')).json().runs[0]
    expect(run).toMatchObject({ status: 'ok', provider: 'deepseek' })
    const steps = (await o.call('GET', `/api/ai/runs/${run.id}`)).json().steps
    expect(steps.find((s: { kind: string }) => s.kind === 'fallback')).toMatchObject({ name: 'anthropic/claude-opus-5-5', status: 'error' })

    claude!.queue.push({ refusal: true })
    deepseek!.chat = () => ({ content: 'Reprise par DeepSeek après refus.' })
    expect((await ask('Autre question')).json().reply.text).toBe('Reprise par DeepSeek après refus.')
    expect(leaked(deepseek!.requests, IDENTIFIERS)).toEqual([])
  })

  it('stops at the monthly ceiling and when every provider is down', async () => {
    const { o, ask } = await setup()
    await enable(o, true, { monthly_token_limit: 1000 })
    await t!.db.run(`INSERT INTO ai_runs (id, org_id, purpose, status, input_tokens, output_tokens) VALUES (?, ?, 'chat', 'ok', 900, 200)`, randomUUID(), o.orgId)
    expect((await ask('Bonjour')).json().reply.text).toMatch(/plafond mensuel/)
    expect(claude!.requests).toHaveLength(0)
    await o.call('PUT', '/api/ai/settings', { ...SETTINGS, monthly_token_limit: null })
    claude!.fallback = () => ({ status: 503 })
    deepseek!.chat = () => ({ status: 503 })
    expect((await ask('Bonjour')).json().reply.text).toMatch(/Aucun modèle de langage ne répond/)
  })

  it('lets only administrators change AI settings and prompts; readers cannot chat-act', async () => {
    const { o } = await setup()
    await o.call('POST', '/api/orgs/current/members', { email: 'op@example.cd', role: 'operator' })
    const op = as(t!, await login(t!, 'op@example.cd'))
    expect((await op('PUT', '/api/ai/settings', SETTINGS)).statusCode).toBe(403)
    expect((await op('POST', `/api/agents/${o.agent.id}/prompts`, { identity: 'x'.repeat(20), instructions: 'y'.repeat(20), style: 'zzz', restrictions: '' })).statusCode).toBe(403)
    expect((await op('GET', '/api/ai/runs')).statusCode).toBe(403)
  })
})

async function uploadKnowledge(o: Org, name: string, text: string, fields: Record<string, string> = {}) {
  const { multipart, ORIGIN } = await import('./helpers.js')
  const body = multipart(fields, { field: 'file', filename: name, bytes: Buffer.from(text, 'utf8') })
  return t!.app.inject({ method: 'POST', url: '/api/knowledge', headers: { origin: ORIGIN, cookie: o.cookie, ...body.headers }, payload: body.payload })
}
