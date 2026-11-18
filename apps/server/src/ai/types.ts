/** Provider-neutral shapes for model calls. Each provider maps them to its own API. */

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: Block[]
  /** The provider's own assistant content (thinking blocks included), replayed unchanged to the same provider and model. */
  native?: { provider: ProviderId; model: string; content: unknown }
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the input object. */
  input_schema: Record<string, unknown>
}

export type ProviderId = 'anthropic' | 'deepseek' | 'local'
export type Effort = 'low' | 'medium' | 'high'

export interface ModelRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  maxTokens: number
  effort?: Effort
  /** JSON Schema the answer must follow (structured output). */
  jsonSchema?: Record<string, unknown>
}

export interface ModelUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

export interface ModelResponse {
  text: string
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'
  usage: ModelUsage
  /** The model that actually answered (a server-side fallback may differ from the one requested). */
  model: string
  /** Assistant content as the provider returned it, to replay in the next turn. */
  native: unknown
}

export interface ModelProvider {
  id: ProviderId
  /** True when data leaves our servers (rule 5: needs the organization's consent). */
  external: boolean
  generate(request: ModelRequest): Promise<ModelResponse>
}

export class ProviderError extends Error {
  constructor(readonly provider: ProviderId, readonly status: number | null, message: string, readonly kind: 'refusal' | 'rate_limit' | 'unavailable' | 'invalid' | 'auth') {
    super(message)
  }
}

export const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
