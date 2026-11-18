/**
 * AI administration for an organization: switch AI on (rule 5), choose external or local models, agent
 * prompts and their versions, agent tools and knowledge use, approvals, runs (observability) and usage.
 * Internal cost in dollars is shown to the platform team only, never as a price to customers (DIRECTIVES §3 G).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit.js'
import { CAN, orgOf, userOf } from '../auth/context.js'
import { notFound } from '../errors.js'
import { decideApproval, listApprovals } from './approvals.js'
import { activePrompt, createPromptVersion, DEFAULT_PROMPTS, GENERIC_PROMPT, listPrompts, PLATFORM_RULES } from './prompts.js'
import { aiAccess, aiSettings } from './router.js'
import { availableTools, DEFAULT_TOOLS } from './tools.js'

const PromptBody = z.object({
  identity: z.string().trim().min(10, 'Décrivez le rôle de l\'agent (10 caractères au moins).').max(4000),
  instructions: z.string().trim().min(10, 'Indiquez ses objectifs (10 caractères au moins).').max(8000),
  style: z.string().trim().min(3).max(2000),
  restrictions: z.string().trim().max(4000),
  note: z.string().trim().max(300).optional(),
  activate: z.boolean().default(true),
}).strict()

const NATIVE_TOOL_NAMES = ['rechercher_connaissances', 'lister_factures', 'solde_credits', 'documents_a_verifier', 'chercher_emails', 'proposer_email', 'proposer_ligne_sheets'] as const

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps
  const Id = z.object({ id: z.string().uuid() })

  app.get('/ai/status', async (request) => {
    const org = orgOf(request)
    const access = await aiAccess(app, org.id, 'chat')
    const ai = config.ai
    return {
      access: { allowed: access.allowed, reason: access.reason, order: access.order },
      settings: access.settings,
      externalConsent: access.externalConsent,
      providers: {
        anthropic: ai.anthropic ? { light: ai.anthropic.models.light, heavy: ai.anthropic.models.heavy } : null,
        deepseek: ai.deepseek ? { light: ai.deepseek.models.light, heavy: ai.deepseek.models.heavy } : null,
        local: ai.local ? { light: ai.local.models.light, heavy: ai.local.models.heavy } : null,
        embeddings: ai.embeddings ? { model: ai.embeddings.model, external: ai.embeddings.external } : null,
      },
    }
  })

  app.put('/ai/settings', async (request) => {
    const org = orgOf(request, CAN.configure)
    const body = z.object({
      enabled: z.boolean(), mode: z.enum(['external', 'local']), use_for_extraction: z.boolean(), use_for_chat: z.boolean(),
      whatsapp_drafts: z.boolean(), monthly_token_limit: z.number().int().min(1000).max(1_000_000_000).nullable(),
    }).strict().parse(request.body)
    await db.run(`INSERT INTO ai_settings (org_id, enabled, mode, use_for_extraction, use_for_chat, whatsapp_drafts, monthly_token_limit, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
      ON CONFLICT (org_id) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode, use_for_extraction = excluded.use_for_extraction,
        use_for_chat = excluded.use_for_chat, whatsapp_drafts = excluded.whatsapp_drafts, monthly_token_limit = excluded.monthly_token_limit,
        updated_by = excluded.updated_by, updated_at = now()`,
    org.id, body.enabled, body.mode, body.use_for_extraction, body.use_for_chat, body.whatsapp_drafts, body.monthly_token_limit, request.user!.id)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'ai.settings_updated', 'organization', org.id, body)
    return { settings: await aiSettings(db, org.id) }
  })

  // ------------------------------------------------------------ prompts (versioned)

  app.get('/agents/:id/prompts', async (request) => {
    const org = orgOf(request)
    const { id } = Id.parse(request.params)
    const agent = await db.get<{ pack_id: string; use_knowledge: boolean; tools: string[] }>('SELECT pack_id, use_knowledge, tools FROM agents WHERE id = ? AND org_id = ?', id, org.id)
    if (!agent) throw notFound('Agent')
    const active = await activePrompt(db, org.id, id)
    return {
      versions: await listPrompts(db, org.id, id), activeId: active?.id ?? null,
      defaults: DEFAULT_PROMPTS[agent.pack_id] ?? GENERIC_PROMPT, platformRules: PLATFORM_RULES,
      settings: { use_knowledge: agent.use_knowledge, tools: agent.tools.length ? agent.tools : DEFAULT_TOOLS },
      tools: NATIVE_TOOL_NAMES,
    }
  })

  app.post('/agents/:id/prompts', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const body = PromptBody.parse(request.body)
    if (!await db.get('SELECT 1 FROM agents WHERE id = ? AND org_id = ?', id, org.id)) throw notFound('Agent')
    const version = await createPromptVersion(db, org.id, id, body, request.user!.id, body.note ?? null, body.activate)
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.prompt_version', 'agent', id, { version: version.version, active: body.activate })
    return { version }
  })

  app.post('/agents/:id/prompts/:promptId/activate', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id, promptId } = z.object({ id: z.string().uuid(), promptId: z.string().uuid() }).parse(request.params)
    const changed = await db.run(`UPDATE agents SET active_prompt_id = ? WHERE id = ? AND org_id = ?
      AND EXISTS (SELECT 1 FROM agent_prompts p WHERE p.id = ? AND p.agent_id = ? AND p.org_id = ?)`, promptId, id, org.id, promptId, id, org.id)
    if (changed === 0) throw notFound('Version')
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.prompt_activated', 'agent', id, { prompt: promptId })
    return { ok: true }
  })

  app.patch('/agents/:id/ai', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const body = z.object({ use_knowledge: z.boolean(), tools: z.array(z.enum(NATIVE_TOOL_NAMES)).max(20) }).strict().parse(request.body)
    const changed = await db.run('UPDATE agents SET use_knowledge = ?, tools = ? WHERE id = ? AND org_id = ?', body.use_knowledge, [...new Set(body.tools)], id, org.id)
    if (changed === 0) throw notFound('Agent')
    await audit(db, { orgId: org.id, userId: request.user!.id }, 'agent.tools_updated', 'agent', id, body)
    return { ok: true }
  })

  /** The tools this person could use through an agent (after role filtering). */
  app.get('/ai/tools', async (request) => {
    const org = orgOf(request)
    const tools = await availableTools(app, org, [])
    return { tools: tools.map(t => ({ name: t.name, label: t.label, permission: t.permission, approval: Boolean(t.approval) })) }
  })

  // ------------------------------------------------------------ approvals

  app.get('/ai/approvals', async (request) => {
    const org = orgOf(request)
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'executed', 'failed', 'expired']).optional() }).parse(request.query)
    return { approvals: await listApprovals(db, org.id, status) }
  })

  app.post('/ai/approvals/:id/:decision', async (request) => {
    const org = orgOf(request)
    const user = userOf(request)
    const { id, decision } = z.object({ id: z.string().uuid(), decision: z.enum(['approve', 'reject']) }).parse(request.params)
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).strict().parse(request.body ?? {})
    return decideApproval(app, org, user, id, decision, reason)
  })

  // ------------------------------------------------------------ observability

  app.get('/ai/runs', async (request) => {
    const org = orgOf(request, CAN.configure)
    const q = z.object({ purpose: z.enum(['chat', 'extraction', 'embedding', 'eval', 'whatsapp']).optional(), status: z.string().max(20).optional() }).parse(request.query)
    return {
      runs: await db.all(`SELECT r.id, r.purpose, r.status, r.provider, r.model, r.tier, r.prompt_version, r.input_tokens, r.output_tokens, r.cache_read_tokens,
        r.cached, r.duration_ms, r.error, r.created_at, a.name AS agent_name, u.email AS user_email,
        (SELECT count(*) FROM ai_run_steps s WHERE s.run_id = r.id) AS steps
        FROM ai_runs r LEFT JOIN agents a ON a.id = r.agent_id AND a.org_id = r.org_id LEFT JOIN users u ON u.id = r.user_id
        WHERE r.org_id = ? AND (?::text IS NULL OR r.purpose = ?::text) AND (?::text IS NULL OR r.status = ?::text)
        ORDER BY r.created_at DESC LIMIT 200`, org.id, q.purpose ?? null, q.purpose ?? null, q.status ?? null, q.status ?? null),
    }
  })

  app.get('/ai/runs/:id', async (request) => {
    const org = orgOf(request, CAN.configure)
    const { id } = Id.parse(request.params)
    const run = await db.get(`SELECT id, purpose, status, provider, model, tier, prompt_version, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cached, duration_ms, error, request_excerpt, response_excerpt, created_at, finished_at FROM ai_runs WHERE id = ? AND org_id = ?`, id, org.id)
    if (!run) throw notFound('Exécution')
    return { run, steps: await db.all('SELECT kind, name, status, detail, duration_ms, created_at FROM ai_run_steps WHERE run_id = ? AND org_id = ? ORDER BY id', id, org.id) }
  })

  /** Usage of the last 30 days: runs, tokens, errors, duration, cache, by day and by purpose (no prices). */
  app.get('/ai/usage', async (request) => {
    const org = orgOf(request, CAN.configure)
    return {
      days: await db.all(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS runs,
        COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens, count(*) FILTER (WHERE status IN ('error', 'blocked'))::int AS errors,
        COALESCE(round(avg(duration_ms)), 0)::int AS avg_ms FROM ai_runs WHERE org_id = ? AND created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`, org.id),
      purposes: await db.all(`SELECT purpose, count(*)::int AS runs, count(*) FILTER (WHERE cached)::int AS cached, count(*) FILTER (WHERE status = 'ok')::int AS ok
        FROM ai_runs WHERE org_id = ? AND created_at >= now() - interval '30 days' GROUP BY purpose ORDER BY runs DESC`, org.id),
      models: await db.all(`SELECT provider, model, count(*)::int AS runs FROM ai_runs WHERE org_id = ? AND model IS NOT NULL AND created_at >= now() - interval '30 days'
        GROUP BY provider, model ORDER BY runs DESC`, org.id),
    }
  })
}
