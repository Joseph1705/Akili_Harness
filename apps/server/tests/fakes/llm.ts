/**
 * Local stand-ins for model providers, reached over real HTTP by the real clients:
 * - an Anthropic Messages API (the official SDK points at it with ANTHROPIC_BASE_URL);
 * - an OpenAI-compatible API (/chat/completions, /embeddings) for DeepSeek, local models and embeddings.
 * Every request body is recorded so tests can check what would have left the server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown>; raw: string }

async function listen(handler: (req: IncomingMessage, raw: string, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => handler(req, raw, res))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

export type AnthropicReply =
  | { text: string }
  | { tool: { name: string; input: Record<string, unknown> }; text?: string }
  | { status: number; error?: string }
  | { refusal: true }

export interface FakeAnthropic {
  url: string
  requests: Recorded[]
  /** Next replies, in order; when empty, `fallback` answers. */
  queue: AnthropicReply[]
  fallback: (body: Record<string, unknown>) => AnthropicReply
  close(): Promise<void>
}

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  let n = 0
  const fake: FakeAnthropic = {
    url: '', requests: [], queue: [], fallback: () => ({ text: 'Réponse de test.' }),
    close: () => new Promise(r => server.close(() => r())),
  }
  const { server, url } = await listen((req, raw, res) => {
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    fake.requests.push({ path: req.url ?? '', headers: req.headers, body, raw })
    if (!req.url?.startsWith('/v1/messages')) return json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } })
    const reply = fake.queue.shift() ?? fake.fallback(body)
    if ('status' in reply) return json(res, reply.status, { type: 'error', error: { type: reply.status === 429 ? 'rate_limit_error' : 'api_error', message: reply.error ?? 'boom' } })
    const id = `msg_${++n}`
    const usage = { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 }
    if ('refusal' in reply) {
      return json(res, 200, { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: null, explanation: null }, usage })
    }
    const content: unknown[] = []
    if ('tool' in reply) {
      if (reply.text) content.push({ type: 'text', text: reply.text })
      content.push({ type: 'tool_use', id: `toolu_${n}`, name: reply.tool.name, input: reply.tool.input })
    } else {
      content.push({ type: 'text', text: reply.text })
    }
    json(res, 200, { id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'tool' in reply ? 'tool_use' : 'end_turn', stop_sequence: null, usage })
  })
  fake.url = url
  return fake
}

export interface FakeOpenAi {
  url: string
  requests: Recorded[]
  chat: (body: Record<string, unknown>) => { status?: number; content?: string; tool?: { name: string; arguments: Record<string, unknown> } }
  close(): Promise<void>
}

/** A deterministic "semantic" embedding: hashed bag of word stems, normalised (enough for retrieval tests). */
export function fakeEmbedding(text: string, dims = 64): number[] {
  const v = new Array<number>(dims).fill(0)
  for (const word of text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) ?? []) {
    const stem = word.slice(0, 6)
    let h = 2166136261
    for (const ch of stem) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    v[Math.abs(h) % dims]! += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map(x => x / norm)
}

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const fake: FakeOpenAi = { url: '', requests: [], chat: () => ({ content: 'Réponse DeepSeek de test.' }), close: () => new Promise(r => server.close(() => r())) }
  const { server, url } = await listen((req, raw, res) => {
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    fake.requests.push({ path: req.url ?? '', headers: req.headers, body, raw })
    if (req.url === '/embeddings') {
      const input = body.input as string[]
      return json(res, 200, { object: 'list', model: body.model, data: input.map((t, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(t) })) })
    }
    if (req.url === '/chat/completions') {
      const r = fake.chat(body)
      if (r.status) return json(res, r.status, { error: { message: 'boom' } })
      const message = r.tool
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: r.tool.name, arguments: JSON.stringify(r.tool.arguments) } }] }
        : { role: 'assistant', content: r.content ?? '' }
      return json(res, 200, { id: 'chatcmpl-1', model: body.model, choices: [{ index: 0, message, finish_reason: r.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 20 } })
    }
    json(res, 404, { error: { message: 'not found' } })
  })
  fake.url = url
  return fake
}

/** True if any recorded request body contains one of these strings (case-insensitive). */
export function leaked(requests: Recorded[], secrets: string[]): string[] {
  return secrets.filter(s => requests.some(r => r.raw.toLowerCase().includes(s.toLowerCase())))
}
