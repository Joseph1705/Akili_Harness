/**
 * DeepSeek (offer Entrepreneur individuel) and self-hosted models (Ollama or any server exposing the
 * OpenAI-compatible /chat/completions and /embeddings endpoints). Plain HTTPS, no SDK.
 */
import { ProviderError, type ChatMessage, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderId } from '../types.js'

interface Endpoint { baseUrl: string; apiKey: string | undefined }

const TIMEOUT_MS = 120_000

async function post(provider: ProviderId, ep: Endpoint, path: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${ep.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
  } catch (error) {
    throw new ProviderError(provider, null, `Fournisseur injoignable (${(error as Error).name}).`, 'unavailable')
  }
  const text = await res.text()
  if (!res.ok) {
    const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'unavailable' : 'invalid'
    throw new ProviderError(provider, res.status, `Erreur du fournisseur (${res.status}).`, kind)
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new ProviderError(provider, res.status, 'Réponse illisible du fournisseur.', 'unavailable')
  }
}

type OaiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

function toOpenAi(system: string, messages: ChatMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
      const calls = m.content.filter(b => b.type === 'tool_use') as Array<{ id: string; name: string; input: Record<string, unknown> }>
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) })
      continue
    }
    const results = m.content.filter(b => b.type === 'tool_result') as Array<{ tool_use_id: string; content: string; is_error?: boolean }>
    for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.is_error ? `ERREUR : ${r.content}` : r.content })
    const text = m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    if (text) out.push({ role: 'user', content: text })
  }
  return out
}

export function openAiCompatibleProvider(id: ProviderId, ep: Endpoint, external: boolean): ModelProvider {
  return {
    id,
    external,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      const system = req.jsonSchema
        ? `${req.system}\n\nRéponds uniquement par un objet JSON valide conforme à ce schéma :\n${JSON.stringify(req.jsonSchema)}`
        : req.system
      const body = await post(id, ep, '/chat/completions', {
        model: req.model,
        messages: toOpenAi(system, req.messages),
        max_tokens: req.maxTokens,
        ...(req.tools?.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
        ...(req.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
      })
      const choice = (body.choices as Array<Record<string, unknown>> | undefined)?.[0]
      const message = choice?.message as { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } | undefined
      if (!message) throw new ProviderError(id, 200, 'Réponse vide du fournisseur.', 'unavailable')
      const toolCalls = (message.tool_calls ?? []).map(c => {
        let input: Record<string, unknown> = {}
        try { input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown> } catch { input = { __invalid_json: c.function.arguments } }
        return { id: c.id, name: c.function.name, input }
      })
      const finish = String(choice?.finish_reason ?? '')
      const usage = body.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | undefined
      return {
        text: message.content ?? '',
        toolCalls,
        stopReason: toolCalls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn',
        usage: { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0, cacheReadTokens: usage?.prompt_cache_hit_tokens ?? 0, cacheWriteTokens: 0 },
        model: String(body.model ?? req.model),
        native: null,
      }
    },
  }
}

/** Embeddings through an OpenAI-compatible /embeddings endpoint (OpenAI, Mistral, Ollama…). */
export async function embed(ep: Endpoint & { model: string }, inputs: string[]): Promise<number[][]> {
  const body = await post('local', ep, '/embeddings', { model: ep.model, input: inputs })
  const data = body.data as Array<{ embedding: number[]; index?: number }> | undefined
  if (!Array.isArray(data) || data.length !== inputs.length) throw new ProviderError('local', 200, 'Réponse d\'embeddings incomplète.', 'unavailable')
  return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(d => d.embedding)
}
