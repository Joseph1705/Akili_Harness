/**
 * Minimal MCP client over Streamable HTTP (Model Context Protocol, JSON-RPC 2.0): initialize, tools/list,
 * tools/call. Responses may be plain JSON or a Server-Sent Events stream. Remote servers only (a SaaS does
 * not start local processes for its customers), reached through the SSRF-guarded HTTP client.
 */
import { safeRequest } from '../security/net.js'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface McpCallResult { text: string; isError: boolean }

export class McpError extends Error {}

interface Options { url: string; token?: string | null; allowPrivate?: boolean; timeoutMs?: number }

export class McpClient {
  private sessionId: string | null = null
  private protocol = MCP_PROTOCOL_VERSION
  private nextId = 1
  private ready = false

  constructor(private readonly opts: Options) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.ready ? { 'mcp-protocol-version': this.protocol } : {}),
    }
  }

  private async rpc(method: string, params: Record<string, unknown> | undefined, notification = false): Promise<Record<string, unknown> | null> {
    const id = notification ? undefined : this.nextId++
    const res = await safeRequest(this.opts.url, {
      method: 'POST', headers: this.headers(), timeoutMs: this.opts.timeoutMs ?? 20_000, allowPrivate: this.opts.allowPrivate,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) }),
    })
    const session = res.headers['mcp-session-id']
    if (typeof session === 'string' && session.length <= 200) this.sessionId = session
    if (notification) {
      if (res.status >= 400) throw new McpError(`Le serveur MCP a refusé ${method} (${res.status}).`)
      return null
    }
    if (res.status === 401 || res.status === 403) throw new McpError('Le serveur MCP refuse l\'accès (jeton manquant ou invalide).')
    if (res.status < 200 || res.status >= 300) throw new McpError(`Le serveur MCP a répondu ${res.status}.`)
    const type = String(res.headers['content-type'] ?? '')
    const messages = type.includes('text/event-stream') ? parseSse(res.body.toString('utf8')) : [safeJson(res.body.toString('utf8'))]
    const reply = messages.find(m => m && (m as { id?: unknown }).id === id) as { result?: Record<string, unknown>; error?: { message?: string } } | undefined
    if (!reply) throw new McpError(`Réponse MCP manquante pour ${method}.`)
    if (reply.error) throw new McpError(`Erreur MCP : ${String(reply.error.message ?? 'inconnue').slice(0, 200)}`)
    return reply.result ?? {}
  }

  async initialize(): Promise<{ serverName: string | null }> {
    const result = await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'akili-harness', version: '1.0.0' },
    })
    if (typeof result?.protocolVersion === 'string') this.protocol = result.protocolVersion
    this.ready = true
    await this.rpc('notifications/initialized', undefined, true)
    const info = result?.serverInfo as { name?: string } | undefined
    return { serverName: typeof info?.name === 'string' ? info.name.slice(0, 120) : null }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {})
      for (const t of (result?.tools as unknown[] | undefined) ?? []) {
        const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown }
        if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(tool.name)) continue
        const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema as Record<string, unknown> : { type: 'object' }
        tools.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description.slice(0, 1000) : undefined, inputSchema: schema })
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools.slice(0, 200)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.rpc('tools/call', { name, arguments: args })
    const content = Array.isArray(result?.content) ? result!.content as Array<{ type?: string; text?: string }> : []
    const text = content.map(c => (c.type === 'text' && typeof c.text === 'string' ? c.text : c.type ? `[contenu ${c.type} non affiché]` : '')).filter(Boolean).join('\n')
    return { text: text.slice(0, 20_000) || (result?.structuredContent ? JSON.stringify(result.structuredContent).slice(0, 20_000) : ''), isError: result?.isError === true }
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

/** Server-Sent Events: each event's data lines form one JSON-RPC message. */
export function parseSse(body: string): unknown[] {
  const out: unknown[] = []
  for (const event of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
    if (data) { const parsed = safeJson(data); if (parsed) out.push(parsed) }
  }
  return out
}
