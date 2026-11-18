/**
 * Tools an agent may use (DIRECTIVES §3 C/E/F). What an agent can do is the intersection of:
 *   - the tools enabled for the agent (and, for MCP, by an administrator — all start disabled);
 *   - the connectors actually connected;
 *   - the role of the person talking to it: an agent never has more rights than that person.
 * Read tools run at once; sensitive tools (sending, writing outside) only create an approval request.
 * Arguments are validated against each tool's schema; results go back to the model as data.
 */
import type { FastifyInstance } from 'fastify'
import type { OrgContext, User } from '../auth/context.js'
import { balanceOf, getWallet } from '../billing/wallet.js'
import { googleScopes, gmailSearch, GOOGLE_SERVICES } from '../connectors/google.js'
import { formatMoney } from '../invoicing/compute.js'
import { searchKnowledge, formatSources } from '../knowledge/store.js'
import { enabledTools, validateArguments } from '../mcp/service.js'
import { allowed, requestApproval, type ApprovalKind, type Permission } from './approvals.js'
import type { ToolSpec } from './types.js'

/** `user` is null for runs no person started (WhatsApp drafts): they get read tools only. */
export interface ToolContext { app: FastifyInstance; org: OrgContext; user: User | null; sessionId: string | null; runId: string }

export interface ToolDef {
  name: string
  label: string
  description: string
  input_schema: Record<string, unknown>
  permission: Permission
  /** Sensitive: never executed by the agent, only proposed for approval. */
  approval?: (ctx: ToolContext, input: Record<string, unknown>) => { kind: ApprovalKind; summary: string; payload: Record<string, unknown> }
  run?: (ctx: ToolContext, input: Record<string, unknown>) => Promise<string>
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

/** Read-only tools every agent gets by default. */
export const DEFAULT_TOOLS = ['rechercher_connaissances', 'lister_factures', 'solde_credits', 'documents_a_verifier']

function nativeTools(): ToolDef[] {
  return [
    {
      name: 'rechercher_connaissances', label: 'Rechercher dans la base de connaissances', permission: 'read',
      description: "Cherche des passages pertinents dans les documents de l'organisation (procédures, contrats, tarifs…). Renvoie des extraits numérotés à citer.",
      input_schema: obj({ question: { type: 'string', description: 'La question ou les mots-clés.' } }, ['question']),
      run: async (ctx, input) => {
        const sources = await searchKnowledge(ctx.app, ctx.org.id, String(input.question ?? '').slice(0, 500), 5)
        return sources.length ? formatSources(sources) : 'Aucun passage trouvé dans la base de connaissances.'
      },
    },
    {
      name: 'lister_factures', label: 'Lister les factures', permission: 'read',
      description: "Liste les factures de l'organisation (numéro, client, montant, statut, paiement, échéance). Filtres facultatifs.",
      input_schema: obj({
        statut: { type: 'string', enum: ['draft', 'validated', 'rejected'], description: 'draft = à valider, validated = validée, rejected = rejetée' },
        impayees: { type: 'boolean', description: 'Seulement les factures validées non entièrement payées.' },
        client: { type: 'string', description: 'Une partie du nom du client.' },
      }),
      run: async (ctx, input) => {
        const like = typeof input.client === 'string' && input.client.trim() ? `%${input.client.trim().replace(/[\\%_]/g, c => `\\${c}`)}%` : null
        const rows = await ctx.app.deps.db.all<{ number: string; client: string; total_cents: number; currency: string; status: string; payment_status: string; due_date: string; amount_paid_cents: number }>(
          `SELECT i.number, c.name AS client, i.total_cents, i.currency, i.status, i.payment_status, i.due_date, i.amount_paid_cents
           FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id
           WHERE i.org_id = ? AND (?::text IS NULL OR i.status = ?::text) AND (?::text IS NULL OR c.name ILIKE ?::text)
             AND (NOT ?::boolean OR (i.status = 'validated' AND i.payment_status <> 'paid'))
           ORDER BY i.created_at DESC LIMIT 25`,
          ctx.org.id, (input.statut as string) ?? null, (input.statut as string) ?? null, like, like, input.impayees === true)
        if (!rows.length) return 'Aucune facture ne correspond.'
        const statut: Record<string, string> = { draft: 'à valider', validated: 'validée', rejected: 'rejetée' }
        const paiement: Record<string, string> = { unpaid: 'non payée', partial: 'partiellement payée', paid: 'payée' }
        return rows.map(r => `${r.number} · ${r.client} · ${formatMoney(r.total_cents)} ${r.currency} · ${statut[r.status]}${r.status === 'validated' ? ` · ${paiement[r.payment_status]} (reste ${formatMoney(r.total_cents - r.amount_paid_cents)}) · échéance ${r.due_date}` : ''}`).join('\n')
      },
    },
    {
      name: 'solde_credits', label: 'Solde de crédits', permission: 'read',
      description: "Renvoie le solde de crédits de l'organisation (1 crédit = 1 facture générée depuis un document) et ses totaux.",
      input_schema: obj({}),
      run: async (ctx) => {
        const w = await getWallet(ctx.app.deps.db, ctx.org.id)
        return `Solde : ${w.balance} crédits. Achetés : ${w.total_purchased}. Utilisés : ${w.total_consumed}. Remboursés : ${w.total_refunded}.`
      },
    },
    {
      name: 'documents_a_verifier', label: 'Documents à vérifier', permission: 'read',
      description: 'Liste les documents reçus qui attendent une vérification humaine avant de devenir des factures, ou qui ont échoué.',
      input_schema: obj({}),
      run: async (ctx) => {
        const rows = await ctx.app.deps.db.all<{ filename: string; status: string; error: string | null; created_at: string }>(
          `SELECT filename, status, error, created_at FROM documents WHERE org_id = ? AND status IN ('needs_review', 'failed', 'waiting_credits')
           ORDER BY created_at DESC LIMIT 20`, ctx.org.id)
        if (!rows.length) return 'Aucun document en attente.'
        const label: Record<string, string> = { needs_review: 'à vérifier', failed: 'en échec', waiting_credits: 'en attente de crédits' }
        return rows.map(r => `${r.filename} · ${label[r.status]}${r.error ? ` (${r.error.slice(0, 120)})` : ''}`).join('\n') + `\nSolde de crédits : ${await balanceOf(ctx.app.deps.db, ctx.org.id)}.`
      },
    },
    {
      name: 'chercher_emails', label: 'Chercher dans Gmail', permission: 'operate',
      description: 'Cherche des e-mails dans la boîte Gmail connectée (syntaxe de recherche Gmail). Renvoie expéditeur, objet, date et extrait.',
      input_schema: obj({ requete: { type: 'string', description: 'Ex. "from:client@exemple.cd facture"' } }, ['requete']),
      run: async (ctx, input) => {
        const mails = await gmailSearch(ctx.app, ctx.org.id, String(input.requete ?? ''), 10)
        return mails.length ? mails.map(m => `<email de="${m.from.replace(/"/g, "'")}" objet="${m.subject.replace(/"/g, "'")}" date="${m.date}">${m.snippet}</email>`).join('\n') : 'Aucun e-mail trouvé.'
      },
    },
    {
      name: 'proposer_email', label: 'Proposer un e-mail (validation requise)', permission: 'operate',
      description: "Prépare un e-mail à envoyer depuis Gmail. Il n'est PAS envoyé : une personne habilitée doit le valider.",
      input_schema: obj({ a: { type: 'string', description: 'Adresse du destinataire.' }, objet: { type: 'string' }, message: { type: 'string' } }, ['a', 'objet', 'message']),
      approval: (_ctx, input) => ({
        kind: 'gmail.send', summary: `E-mail à ${String(input.a)} — « ${String(input.objet).slice(0, 80)} »`,
        payload: { to: String(input.a).slice(0, 254), subject: String(input.objet).slice(0, 200), body: String(input.message).slice(0, 20_000) },
      }),
    },
    {
      name: 'proposer_ligne_sheets', label: 'Proposer des lignes Google Sheets (validation requise)', permission: 'operate',
      description: "Prépare l'ajout de lignes dans une feuille Google Sheets. Rien n'est écrit sans la validation d'une personne habilitée.",
      input_schema: obj({
        feuille_id: { type: 'string', description: "Identifiant de la feuille (dans son adresse)." },
        plage: { type: 'string', description: 'Ex. Factures!A1' },
        lignes: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      }, ['feuille_id', 'plage', 'lignes']),
      approval: (_ctx, input) => ({
        kind: 'sheets.append', summary: `${(input.lignes as unknown[]).length} ligne(s) dans Google Sheets (${String(input.plage)})`,
        payload: { spreadsheetId: String(input.feuille_id), range: String(input.plage), values: (input.lignes as unknown[][]).map(r => r.map(c => String(c))) },
      }),
    },
  ]
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'serveur'
}

/** The tools this person may use with this agent, right now. */
export async function availableTools(app: FastifyInstance, org: OrgContext, agentTools: string[]): Promise<ToolDef[]> {
  const { db } = app.deps
  const scopes = await googleScopes(db, org.id)
  const connectorOk: Record<string, boolean> = {
    chercher_emails: Boolean(scopes?.includes(GOOGLE_SERVICES.gmail_read.scopes[0])),
    proposer_email: Boolean(scopes?.includes(GOOGLE_SERVICES.gmail_send.scopes[0])),
    proposer_ligne_sheets: Boolean(scopes?.includes(GOOGLE_SERVICES.sheets.scopes[0])),
  }
  const wanted = new Set(agentTools.length ? agentTools : [...DEFAULT_TOOLS, ...Object.keys(connectorOk)])
  const native = nativeTools().filter(t => wanted.has(t.name) && (connectorOk[t.name] ?? true))
  const mcp: ToolDef[] = (await enabledTools(db, org.id)).map(t => ({
    name: `mcp_${slug(t.server_name)}_${t.name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64),
    label: `${t.server_name} · ${t.name}`,
    description: `${t.description ?? t.name} (outil externe ${t.server_name}${t.requires_approval ? ', validation humaine requise' : ''})`.slice(0, 1000),
    input_schema: t.input_schema.type === 'object' ? t.input_schema : obj({}),
    permission: t.permission,
    ...(t.requires_approval
      ? { approval: (_ctx: ToolContext, input: Record<string, unknown>) => ({ kind: 'mcp.call' as const, summary: `${t.server_name} · ${t.name}`, payload: { toolId: t.id, arguments: input } }) }
      : { run: async (ctx: ToolContext, input: Record<string, unknown>) => {
          const { callTool } = await import('../mcp/service.js')
          const r = await callTool(ctx.app, ctx.org.id, t.id, input)
          return r.isError ? `ERREUR de l'outil : ${r.text}` : r.text
        } }),
  }))
  // Never more than the person: tools above the user's role are not even offered to the model.
  return [...native, ...mcp].filter(t => allowed(org.role, t.permission))
}

export function toolSpecs(tools: ToolDef[]): ToolSpec[] {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
}

export type ToolOutcome = { content: string; isError: boolean; approvalId?: string; summary?: string }

/** Run one tool call from the model, or turn it into an approval request. */
export async function executeTool(ctx: ToolContext, tools: ToolDef[], name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = tools.find(t => t.name === name)
  if (!tool) return { content: `Outil « ${name} » indisponible pour cette personne ou cet agent.`, isError: true }
  // Defense in depth: the role is checked again at execution time.
  if (!allowed(ctx.org.role, tool.permission)) return { content: 'Action non autorisée pour votre rôle.', isError: true }
  const invalid = validateArguments(tool.input_schema, input)
  if (invalid) return { content: invalid, isError: true }
  if (tool.approval) {
    const a = tool.approval(ctx, input)
    const { id } = await requestApproval(ctx.app.deps.db, { orgId: ctx.org.id, kind: a.kind, summary: a.summary, payload: a.payload, permission: tool.permission, requestedBy: ctx.user?.id ?? null, sessionId: ctx.sessionId, runId: ctx.runId })
    return { content: `Demande de validation n° ${id.slice(0, 8)} créée : « ${a.summary} ». Rien n'a été envoyé ; une personne habilitée doit approuver l'action.`, isError: false, approvalId: id, summary: a.summary }
  }
  try {
    return { content: (await tool.run!(ctx, input)).slice(0, 20_000), isError: false }
  } catch (error) {
    return { content: `L'outil a échoué : ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), isError: true }
  }
}
