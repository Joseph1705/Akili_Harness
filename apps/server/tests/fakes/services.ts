/**
 * Local stand-ins for an MCP server (Streamable HTTP, JSON and SSE answers), Google (OAuth with PKCE check,
 * userinfo, Gmail, Sheets, revoke) and Meta's Graph API for WhatsApp. Real HTTP, protocol-shaped answers.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

async function listen(handler: (req: IncomingMessage, raw: string, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => handler(req, raw, res))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }

// ------------------------------------------------------------ MCP

export interface FakeMcp { url: string; token: string; calls: Array<{ name: string; arguments: unknown }>; close(): Promise<void> }

export async function startFakeMcp(): Promise<FakeMcp> {
  const fake: FakeMcp = { url: '', token: 'mcp-test-token', calls: [], close: () => new Promise(r => server.close(() => r())) }
  const { server, url } = await listen((req, raw, res) => {
    if (req.headers.authorization !== `Bearer ${fake.token}`) return json(res, 401, { error: 'unauthorized' })
    const msg = JSON.parse(raw || '{}') as { id?: number; method: string; params?: Record<string, unknown> }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
    if (msg.method === 'initialize') {
      return json(res, 200, reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'outils-test', version: '1.0' } }), { 'mcp-session-id': 'session-1' })
    }
    if (req.headers['mcp-session-id'] !== 'session-1') return json(res, 400, { error: 'missing session' })
    if (msg.method === 'tools/list') {
      return json(res, 200, reply({
        tools: [
          { name: 'taux_de_change', description: 'Taux de change du jour (fictif).', inputSchema: { type: 'object', properties: { devise: { type: 'string', enum: ['USD', 'CDF'] } }, required: ['devise'], additionalProperties: false } },
          { name: 'creer_ticket', description: 'Crée un ticket de support.', inputSchema: { type: 'object', properties: { titre: { type: 'string' } }, required: ['titre'] } },
        ],
      }))
    }
    if (msg.method === 'tools/call') {
      const params = msg.params as { name: string; arguments: Record<string, unknown> }
      fake.calls.push({ name: params.name, arguments: params.arguments })
      const text = params.name === 'taux_de_change' ? '1 USD = 2 850 CDF (taux fictif de test)' : `Ticket T-${fake.calls.length} créé : ${String(params.arguments.titre)}`
      // This one answers as a Server-Sent Events stream, like many Streamable HTTP servers.
      if (params.name === 'creer_ticket') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`)
        res.end(`event: message\ndata: ${JSON.stringify(reply({ content: [{ type: 'text', text }], isError: false }))}\n\n`)
        return
      }
      return json(res, 200, reply({ content: [{ type: 'text', text }], isError: false }))
    }
    json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  })
  fake.url = `${url}/mcp`
  return fake
}

// ------------------------------------------------------------ Google

export interface FakeGoogle {
  url: string
  /** code → PKCE challenge it was issued for (the test plays Google's consent screen). */
  issue(challenge: string): string
  sent: Array<{ raw: string }>
  appended: Array<{ spreadsheet: string; range: string; values: string[][] }>
  revoked: string[]
  close(): Promise<void>
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const codes = new Map<string, string>()
  let n = 0
  const fake: FakeGoogle = {
    url: '', sent: [], appended: [], revoked: [],
    issue(challenge) { const code = `code-${++n}`; codes.set(code, challenge); return code },
    close: () => new Promise(r => server.close(() => r())),
  }
  const { server, url } = await listen((req, raw, res) => {
    const path = (req.url ?? '').split('?')[0]!
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
    const auth = req.headers.authorization
    if (path === '/token') {
      const form = new URLSearchParams(raw)
      if (form.get('client_id') !== 'google-client' || form.get('client_secret') !== 'google-secret') return json(res, 401, { error: 'invalid_client' })
      if (form.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const expected = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (!challenge || challenge !== expected) return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, { access_token: 'ya29.test-access', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/spreadsheets' })
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1') return json(res, 200, { access_token: 'ya29.refreshed', expires_in: 3600 })
      return json(res, 400, { error: 'invalid_grant' })
    }
    if (path === '/revoke') { fake.revoked.push(query.get('token') ?? ''); return json(res, 200, {}) }
    if (!auth?.startsWith('Bearer ya29.')) return json(res, 401, { error: { message: 'invalid token' } })
    if (path === '/userinfo') return json(res, 200, { email: 'compta@kibala.example', email_verified: true })
    if (path === '/gmail/v1/users/me/messages' && req.method === 'GET') return json(res, 200, { messages: [{ id: 'abc123def', threadId: 't1' }] })
    if (path === '/gmail/v1/users/me/messages/abc123def') {
      return json(res, 200, { id: 'abc123def', snippet: 'Merci de nous envoyer la facture du mois (fictif).', payload: { headers: [{ name: 'From', value: 'Tshala <comptabilite@tshala-logistique.example>' }, { name: 'Subject', value: 'Facture octobre' }, { name: 'Date', value: 'Mon, 16 Nov 2026 10:00:00 +0200' }] } })
    }
    if (path === '/gmail/v1/users/me/messages/send') { fake.sent.push(JSON.parse(raw)); return json(res, 200, { id: 'sent-1', threadId: 't9' }) }
    const sheet = /^\/v4\/spreadsheets\/([^/]+)\/values\/([^:]+):append$/.exec(path)
    if (sheet && req.method === 'POST') {
      const body = JSON.parse(raw) as { values: string[][] }
      fake.appended.push({ spreadsheet: sheet[1]!, range: decodeURIComponent(sheet[2]!), values: body.values })
      return json(res, 200, { updates: { updatedRange: `${decodeURIComponent(sheet[2]!)}:I${body.values.length}`, updatedRows: body.values.length } })
    }
    json(res, 404, { error: { message: 'not found' } })
  })
  fake.url = url
  return fake
}

// ------------------------------------------------------------ Meta (WhatsApp Cloud API)

export interface FakeMeta { url: string; token: string; sent: Array<Record<string, unknown>>; close(): Promise<void> }

export async function startFakeMeta(): Promise<FakeMeta> {
  const fake: FakeMeta = { url: '', token: 'EAAtesttoken1234567890abcdef', sent: [], close: () => new Promise(r => server.close(() => r())) }
  const { server, url } = await listen((req, raw, res) => {
    if (req.headers.authorization !== `Bearer ${fake.token}`) return json(res, 401, { error: { message: 'Invalid OAuth access token' } })
    const path = (req.url ?? '').split('?')[0]!
    if (req.method === 'GET' && /^\/v23\.0\/\d+$/.test(path)) return json(res, 200, { display_phone_number: '+243 970 000 000', verified_name: 'Kibala Services (fictif)', id: path.split('/')[2] })
    if (req.method === 'POST' && /^\/v23\.0\/\d+\/messages$/.test(path)) {
      fake.sent.push(JSON.parse(raw))
      return json(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.out${fake.sent.length}` }] })
    }
    json(res, 404, { error: { message: 'not found' } })
  })
  fake.url = url
  return fake
}
