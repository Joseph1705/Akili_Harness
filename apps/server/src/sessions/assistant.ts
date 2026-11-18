/**
 * Session assistant. Commands are answered by code from the organization's own data, without any model.
 * Free text goes to the agent (ai/agent.ts) when the organization enabled AI; otherwise the assistant says
 * plainly why it cannot answer (rule 5) instead of pretending.
 */
import type { FastifyInstance } from 'fastify'
import type { OrgContext, User } from '../auth/context.js'
import { balance } from '../credits.js'
import { formatMoney } from '../invoicing/compute.js'
import { runAgent } from '../ai/agent.js'

export interface Reply {
  text: string
  items?: Array<{ label: string; value: string; href?: string }>
  approvals?: Array<{ id: string; summary: string }>
  model?: string
}

export const COMMANDS = [
  { cmd: '/facturer', desc: 'Déposer des documents et préparer les factures' },
  { cmd: '/validations', desc: 'Factures qui attendent votre validation' },
  { cmd: '/solde', desc: 'Crédits restants' },
  { cmd: '/agents', desc: 'État de vos agents' },
  { cmd: '/aide', desc: 'Liste des commandes' },
]

export async function answer(app: FastifyInstance, org: OrgContext, user: User, sessionId: string, agentId: string | null, text: string): Promise<Reply> {
  const { db } = app.deps
  const command = text.trim().split(/\s+/)[0]!.toLowerCase()
  switch (command) {
    case '/aide':
      return { text: 'Voici ce que je sais faire. Vous pouvez aussi poser une question libre si l\'intelligence artificielle est activée.', items: COMMANDS.map(c => ({ label: c.cmd, value: c.desc })) }
    case '/solde': {
      const n = await balance(db, org.id)
      return { text: `Il vous reste ${n} crédit${n > 1 ? 's' : ''}. Un crédit = une facture générée à partir d'un document.` }
    }
    case '/validations': {
      const rows = await db.all<{ id: string; number: string; total_cents: number; currency: string; name: string }>(`SELECT i.id, i.number, i.total_cents, i.currency, c.name FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id
        WHERE i.org_id = ? AND i.status = 'draft' ORDER BY i.created_at LIMIT 10`, org.id)
      if (rows.length === 0) return { text: 'Aucune facture en attente de validation.' }
      return { text: `${rows.length} facture${rows.length > 1 ? 's' : ''} attend${rows.length > 1 ? 'ent' : ''} votre validation :`, items: rows.map(r => ({ label: `${r.number} · ${r.name}`, value: `${formatMoney(r.total_cents)} ${r.currency}`, href: `/validations/${r.id}` })) }
    }
    case '/agents': {
      const rows = await db.all<{ name: string; status: string }>('SELECT name, status FROM agents WHERE org_id = ? ORDER BY created_at', org.id)
      if (rows.length === 0) return { text: "Vous n'avez pas encore d'agent. Créez-en un depuis « Packs d'agents »." }
      return { text: 'Vos agents :', items: rows.map(r => ({ label: r.name, value: r.status === 'active' ? 'actif' : 'en pause' })) }
    }
    case '/facturer':
      return { text: "Déposez vos documents (PDF, scan, photo, Word, Excel ou CSV) avec le bouton « Joindre des documents ». Je lis chaque document ; les rapports d'activité sont chiffrés selon le contrat, les autres documents vous sont présentés pour vérification avant de devenir des factures." }
    default: {
      const reply = await runAgent(app, { org, user, sessionId, agentId, text })
      return {
        text: reply.text,
        ...(reply.sources?.length ? { items: reply.sources.map(s => ({ label: `[${s.n}]`, value: s.heading ? `${s.title} — ${s.heading}` : s.title })) } : {}),
        ...(reply.approvals?.length ? { approvals: reply.approvals } : {}),
        ...(reply.model ? { model: reply.model } : {}),
      }
    }
  }
}
