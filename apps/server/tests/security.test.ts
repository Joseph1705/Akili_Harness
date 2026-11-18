/** Security boundaries (DIRECTIVES §7, §9): forged requests, isolation, limits, headers, secrets, retention. */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { drainJobs } from '../src/jobs.js'
import { purgeExpired } from '../src/maintenance.js'
import { as, createTestApp, login, multipart, ORIGIN, readyOrg, type TestContext } from './helpers.js'
import { startFakeMcp } from './fakes/services.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })
const key = () => ({ 'idempotency-key': randomUUID() })

describe('requests that do not come from our own pages', () => {
  it('refuses state-changing requests without our Origin (CSRF)', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    for (const origin of [undefined, 'https://evil.example', 'null']) {
      const res = await t.app.inject({ method: 'POST', url: '/api/invoices', headers: { cookie: o.cookie, ...(origin ? { origin } : {}), ...key() }, payload: {} })
      expect(res.statusCode, String(origin)).toBe(403)
    }
  })

  it('sends strict security headers on every answer', async () => {
    t = await createTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/api/public/config' })
    expect(res.headers['content-security-policy']).toContain("script-src 'self'")
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['permissions-policy']).toContain('camera=()')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })
})

describe('isolation between organizations, on every feature', () => {
  it('never lets organization A read or change what belongs to B', async () => {
    const mcp = await startFakeMcp()
    try {
      t = await createTestApp({ AKILI_MCP_ALLOW_PRIVATE: '1' })
      const a = await readyOrg(t, 'a@example.cd')
      const b = await readyOrg(t, 'b@example.cd')
      // B's objects.
      const kb = multipart({}, { field: 'file', filename: 'b.txt', bytes: Buffer.from('Procédure interne de B : ne pas divulguer. '.repeat(3)) })
      const knowledge = (await t.app.inject({ method: 'POST', url: '/api/knowledge', headers: { origin: ORIGIN, cookie: b.cookie, ...kb.headers }, payload: kb.payload })).json().document
      const server = (await b.call('POST', '/api/mcp', { name: 'Serveur B', url: mcp.url, token: mcp.token })).json().server
      const tool = (await b.call('GET', '/api/mcp')).json().tools[0]
      await b.uploadDoc('Demande_facturation_Kalembe.txt')
      await drainJobs(t.app)
      const doc = (await b.call('GET', '/api/documents')).json().documents.find((d: { status: string }) => d.status === 'needs_review')
      const invoice = (await b.call('POST', '/api/invoices', { client: { name: 'Client B', vat_applicable: false }, issue_date: '2026-11-18', due_date: '2026-11-30', currency: 'USD', lines: [{ description: 'X', quantity: '1', unit_price: '1' }], vat_rate_bp: 0 }, key())).json().invoice
      const runId = randomUUID()
      await t.db.run("INSERT INTO ai_runs (id, org_id, purpose, status) VALUES (?, ?, 'chat', 'ok')", runId, b.orgId)
      const approvalId = randomUUID()
      await t.db.run(`INSERT INTO action_approvals (id, org_id, kind, summary, payload, permission, status, expires_at) VALUES (?, ?, 'gmail.send', 'x', '{}', 'operate', 'pending', now() + interval '1 day')`, approvalId, b.orgId)

      for (const [method, url, body] of [
        ['GET', `/api/knowledge/${knowledge.id}`, undefined], ['DELETE', `/api/knowledge/${knowledge.id}`, undefined],
        ['POST', `/api/mcp/${server.id}/discover`, {}], ['DELETE', `/api/mcp/${server.id}`, undefined],
        ['PATCH', `/api/mcp/tools/${tool.id}`, { enabled: true, permission: 'read', requires_approval: false }], ['POST', `/api/mcp/tools/${tool.id}/call`, { arguments: { devise: 'USD' } }],
        ['GET', `/api/documents/${doc.id}`, undefined], ['POST', `/api/documents/${doc.id}/dismiss`, {}],
        ['POST', `/api/documents/${doc.id}/invoice`, { client: { name: 'Client A', vat_applicable: false }, issue_date: '2026-11-18', due_date: '2026-11-30', currency: 'USD', lines: [{ description: 'X', quantity: '1', unit_price: '1' }], vat_rate_bp: 0 }],
        ['GET', `/api/invoices/${invoice.id}`, undefined], ['GET', `/api/ai/runs/${runId}`, undefined], ['POST', `/api/ai/approvals/${approvalId}/approve`, {}],
        ['POST', `/api/agents/${b.agent.id}/prompts`, { identity: 'x'.repeat(20), instructions: 'y'.repeat(20), style: 'zzz', restrictions: '' }],
        ['GET', `/api/agents/${b.agent.id}/prompts`, undefined],
      ] as const) {
        const res = await a.call(method, url, body, key())
        expect([403, 404, 409].includes(res.statusCode) && res.statusCode !== 200, `${method} ${url} → ${res.statusCode}`).toBe(true)
        expect(res.statusCode, `${method} ${url}`).not.toBe(200)
      }
      // Lists never mix organizations.
      expect((await a.call('GET', '/api/knowledge')).json().documents).toHaveLength(0)
      expect((await a.call('GET', '/api/mcp')).json().servers).toHaveLength(0)
      expect((await a.call('GET', '/api/ai/runs')).json().runs).toHaveLength(0)
      expect((await a.call('GET', '/api/ai/approvals')).json().approvals).toHaveLength(0)
      expect((await a.call('GET', '/api/credits')).json().entries.every((e: { type: string }) => e.type === 'admin_allocation')).toBe(true)
      // B's knowledge is still there.
      expect((await b.call('GET', `/api/knowledge/${knowledge.id}`)).statusCode).toBe(200)
    } finally { await mcp.close() }
  })
})

describe('abuse and injection', () => {
  it('limits questions to the AI per person', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const sid = (await o.call('POST', '/api/sessions', { title: 'x' })).json().session.id
    const codes: number[] = []
    for (let i = 0; i < 32; i++) codes.push((await o.call('POST', `/api/sessions/${sid}/messages`, { text: '/solde' })).statusCode)
    expect(codes.slice(0, 30).every(c => c === 200)).toBe(true)
    expect(codes.slice(30)).toEqual([429, 429])
  })

  it('treats SQL and markup in inputs as plain text', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const other = await readyOrg(t, 'other@example.cd')
    await other.call('POST', '/api/invoices', { client: { name: 'Secret SA', vat_applicable: false }, issue_date: '2026-11-18', due_date: '2026-11-30', currency: 'USD', lines: [{ description: 'X', quantity: '1', unit_price: '1' }], vat_rate_bp: 0 }, key())
    for (const q of ["' OR 1=1 --", "%' UNION SELECT * FROM users --", '\\', '_%']) {
      const res = await o.call('GET', `/api/invoices?q=${encodeURIComponent(q)}`)
      expect(res.statusCode, q).toBe(200)
      expect(res.json().invoices, q).toHaveLength(0)
    }
    const xss = '<img src=x onerror=alert(1)><script>alert(1)</script>'
    const created = (await o.call('POST', '/api/invoices', { client: { name: xss, vat_applicable: false }, issue_date: '2026-11-18', due_date: '2026-11-30', currency: 'USD', lines: [{ description: xss, quantity: '1', unit_price: '1' }], vat_rate_bp: 0 }, key())).json().invoice
    // Stored as text (the interface escapes it; the CSP forbids inline scripts), and the PDF renders it as text.
    expect(created.client.name).toBe(xss)
    expect((await o.call('GET', `/api/invoices/${created.id}/pdf`)).statusCode).toBe(200)
  })

  it('never sends secrets back: tokens of tools and connectors stay on the server', async () => {
    const mcp = await startFakeMcp()
    try {
      t = await createTestApp({ AKILI_MCP_ALLOW_PRIVATE: '1' })
      const o = await readyOrg(t)
      await o.call('POST', '/api/mcp', { name: 'Outils', url: mcp.url, token: mcp.token })
      for (const url of ['/api/mcp', '/api/connectors', '/api/ai/status', '/api/auth/me']) {
        expect((await o.call('GET', url)).body, url).not.toContain(mcp.token)
      }
      const stored = await t.db.get<{ auth_secret: Buffer }>('SELECT auth_secret FROM mcp_servers')
      expect(stored!.auth_secret.toString('latin1')).not.toContain(mcp.token)
    } finally { await mcp.close() }
  })
})

describe('sessions, members and retention', () => {
  it('ends access when a session is revoked or a member removed', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    await o.call('POST', '/api/orgs/current/members', { email: 'op@example.cd', role: 'operator' })
    const opCookie = await login(t, 'op@example.cd')
    const op = as(t, opCookie)
    expect((await op('GET', '/api/invoices')).statusCode).toBe(200)
    const member = (await o.call('GET', '/api/orgs/current/members')).json().members.find((m: { email: string }) => m.email === 'op@example.cd')
    expect((await o.call('DELETE', `/api/orgs/current/members/${member.id}`)).statusCode).toBe(200)
    expect((await op('GET', '/api/invoices')).statusCode).toBe(409) // no organization any more
    await op('POST', '/api/auth/logout')
    expect((await op('GET', '/api/auth/me')).statusCode).toBe(401)
    // The owner cannot be removed, and only administrators remove anyone.
    const owner = (await o.call('GET', '/api/orgs/current/members')).json().members.find((m: { role: string }) => m.role === 'owner')
    expect((await o.call('DELETE', `/api/orgs/current/members/${owner.id}`)).statusCode).toBe(404)
  })

  it('exports an organization\'s data for its administrators only', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const res = await o.call('GET', '/api/orgs/current/export')
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json())).toEqual(expect.arrayContaining(['organization', 'invoices', 'credit_transactions', 'audit_log']))
    await o.call('POST', '/api/orgs/current/members', { email: 'r@example.cd', role: 'reader' })
    expect((await as(t, await login(t, 'r@example.cd'))('GET', '/api/orgs/current/export')).statusCode).toBe(403)
  })

  it('erases old AI excerpts and expired secrets, never financial history', async () => {
    t = await createTestApp({ AKILI_AI_LOG_RETENTION_DAYS: '30' })
    const o = await readyOrg(t)
    const old = randomUUID()
    await t.db.run(`INSERT INTO ai_runs (id, org_id, purpose, status, request_excerpt, response_excerpt, input_tokens, created_at)
      VALUES (?, ?, 'chat', 'ok', 'question', 'réponse', 50, now() - interval '40 days')`, old, o.orgId)
    await t.db.run("INSERT INTO login_codes (id, email, code_hash, expires_at, created_at) VALUES (?, 'x@example.cd', 'h', now() - interval '2 days', now() - interval '2 days')", randomUUID())
    const ledgerBefore = await t.db.all('SELECT * FROM credit_transactions')
    await purgeExpired(t.db, t.config)
    expect(await t.db.get('SELECT request_excerpt, response_excerpt, input_tokens FROM ai_runs WHERE id = ?', old)).toEqual({ request_excerpt: null, response_excerpt: null, input_tokens: 50 })
    expect(await t.db.get("SELECT 1 FROM login_codes WHERE email = 'x@example.cd'")).toBeUndefined()
    expect(await t.db.all('SELECT * FROM credit_transactions')).toEqual(ledgerBefore)
  })
})
