/**
 * Observability (DIRECTIVES §3 H): every model run with its steps (retrieval, guardrails, model calls,
 * fallbacks, tools, approvals), tokens, internal cost, duration and errors. Prompts and answers are
 * stored pseudonymised and truncated; secrets are redacted. Internal cost is for us, never a price shown
 * to customers (they pay per document, DIRECTIVES §5).
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import type { ModelUsage } from './types.js'

/** USD per million tokens. Sources: Anthropic list prices (Claude API skill table, 2026-11-03); DeepSeek: model catalog of the pinned DeepSeek Harness, NOT verified (rule 12). */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
}

/** USD per million tokens is micro-USD per token: the cost in micro-USD is an exact integer sum. */
export function costMicroUsd(model: string, provider: string, u: ModelUsage): number {
  if (provider === 'local') return 0
  const p = PRICES[model]
  if (!p) return 0
  return Math.round(u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite)
}

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{10,}/g, /sk_(?:live|test)_[A-Za-z0-9]{6,}/g, /Bearer\s+[A-Za-z0-9._-]{10,}/g, /EAA[A-Za-z0-9]{20,}/g, /ya29\.[A-Za-z0-9._-]{10,}/g]

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[secret masqué]'), text)
}

export function excerpt(text: string, max = 2000): string {
  const t = redactSecrets(text)
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export interface RunInfo {
  orgId: string
  purpose: 'chat' | 'extraction' | 'embedding' | 'eval' | 'whatsapp'
  userId?: string | null
  agentId?: string | null
  sessionId?: string | null
  documentId?: string | null
}

export interface RunResult {
  status: 'ok' | 'error' | 'blocked' | 'refused' | 'awaiting_approval'
  provider?: string | null
  model?: string | null
  tier?: string | null
  promptVersion?: number | null
  usage?: ModelUsage
  cached?: boolean
  error?: string | null
  request?: string | null
  response?: string | null
}

export interface Run {
  id: string
  /** Record one step; detail must already be pseudonymised. */
  step(kind: 'model' | 'retrieval' | 'tool' | 'guardrail' | 'approval' | 'fallback' | 'cache' | 'budget', name: string, status: 'ok' | 'error' | 'blocked' | 'skipped', detail?: Record<string, unknown>, durationMs?: number): Promise<void>
  /** Add tokens of one model call (a run may call the model several times). */
  addUsage(model: string, provider: string, usage: ModelUsage): void
  finish(result: RunResult): Promise<void>
}

export async function startRun(db: Db, info: RunInfo): Promise<Run> {
  const id = randomUUID()
  const started = Date.now()
  const total: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let cost = 0
  await db.run(`INSERT INTO ai_runs (id, org_id, user_id, agent_id, session_id, document_id, purpose, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
    id, info.orgId, info.userId ?? null, info.agentId ?? null, info.sessionId ?? null, info.documentId ?? null, info.purpose)
  const addUsage = (model: string, provider: string, usage: ModelUsage) => {
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.cacheReadTokens += usage.cacheReadTokens
    total.cacheWriteTokens += usage.cacheWriteTokens
    cost += costMicroUsd(model, provider, usage)
  }
  return {
    id,
    async step(kind, name, status, detail, durationMs) {
      await db.run('INSERT INTO ai_run_steps (run_id, org_id, kind, name, status, detail, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, info.orgId, kind, name.slice(0, 120), status, detail ? JSON.stringify(detail).slice(0, 8000) : null, durationMs ?? null)
    },
    addUsage,
    async finish(r) {
      if (r.usage) addUsage(r.model ?? '', r.provider ?? '', r.usage)
      await db.run(`UPDATE ai_runs SET status = ?, provider = ?, model = ?, tier = ?, prompt_version = ?, input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, cost_micro_usd = ?, cached = ?, duration_ms = ?, error = ?, request_excerpt = ?, response_excerpt = ?,
        finished_at = now() WHERE id = ?`,
      r.status, r.provider ?? null, r.model ?? null, r.tier ?? null, r.promptVersion ?? null, total.inputTokens, total.outputTokens,
      total.cacheReadTokens, total.cacheWriteTokens, cost, r.cached ?? false, Date.now() - started, r.error ? excerpt(r.error, 500) : null,
      r.request ? excerpt(r.request) : null, r.response ? excerpt(r.response) : null, id)
    },
  }
}
