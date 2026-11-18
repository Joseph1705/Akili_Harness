/**
 * Claude through the official Anthropic SDK (offer Entreprise).
 *
 * - System prompt marked for prompt caching (it is the stable part of every request).
 * - Effort and structured output go in `output_config`; thinking is left to the model (adaptive by default on
 *   current models — it cannot be disabled on Claude Opus 5.5).
 * - A declined request (stop_reason "refusal") is retried server-side on Anthropic's recommended fallback model
 *   for the models that support it (`fallbacks: "default"`, beta server-side-fallback-2026-07-01). If the whole
 *   chain refuses, a ProviderError("refusal") is raised so the router can try another provider.
 * - Assistant turns are replayed with their native content (thinking blocks included) on the same model.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { ModelEndpoint } from '../../config.js'
import { ProviderError, type Block, type ChatMessage, type ModelProvider, type ModelRequest, type ModelResponse } from '../types.js'

/** Models with server-side refusal fallback (Claude Haiku 5.5 has none: sending it there is an error). */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5'])

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming

function toAnthropic(message: ChatMessage, model: string): Anthropic.Beta.Messages.BetaMessageParam {
  if (message.role === 'assistant' && message.native?.provider === 'anthropic' && message.native.model === model) {
    return { role: 'assistant', content: message.native.content as Anthropic.Beta.Messages.BetaContentBlockParam[] }
  }
  const content = message.content.map((b: Block): Anthropic.Beta.Messages.BetaContentBlockParam => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
    return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) }
  })
  return { role: message.role, content }
}

export function anthropicProvider(cfg: ModelEndpoint): ModelProvider {
  // Retries are done by our router across providers; one SDK retry covers short network blips.
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}), maxRetries: 1, timeout: 120_000 })

  return {
    id: 'anthropic',
    external: true,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      const outputConfig = {
        ...(req.effort ? { effort: req.effort } : {}),
        ...(req.jsonSchema ? { format: { type: 'json_schema' as const, schema: req.jsonSchema } } : {}),
      }
      const params: Params = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages.map(m => toAnthropic(m, req.model)),
        ...(req.tools?.length ? { tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema })) } : {}),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        ...(SERVER_FALLBACK_MODELS.has(req.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }
      let res: Anthropic.Beta.Messages.BetaMessage
      try {
        res = await client.beta.messages.create(params)
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) throw new ProviderError('anthropic', 429, 'Limite de débit du fournisseur atteinte.', 'rate_limit')
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new ProviderError('anthropic', error.status, 'Clé du fournisseur refusée.', 'auth')
        if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError || error instanceof Anthropic.UnprocessableEntityError) {
          throw new ProviderError('anthropic', error.status, `Requête refusée par le fournisseur (${error.status}).`, 'invalid')
        }
        if (error instanceof Anthropic.APIConnectionError) throw new ProviderError('anthropic', null, 'Fournisseur injoignable.', 'unavailable')
        if (error instanceof Anthropic.APIError) throw new ProviderError('anthropic', error.status ?? null, `Erreur du fournisseur (${error.status ?? 'réseau'}).`, 'unavailable')
        throw error
      }
      // Always look at the stop reason before reading the content.
      if (res.stop_reason === 'refusal') {
        throw new ProviderError('anthropic', 200, `Le modèle a décliné la demande${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}.`, 'refusal')
      }
      const text = res.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map(b => b.text).join('')
      const toolCalls = res.content
        .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }))
      const u = res.usage
      return {
        text, toolCalls,
        stopReason: res.stop_reason === 'end_turn' ? 'end_turn' : res.stop_reason === 'tool_use' ? 'tool_use' : res.stop_reason === 'max_tokens' ? 'max_tokens' : 'other',
        usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 },
        model: res.model,
        native: res.content,
      }
    },
  }
}
