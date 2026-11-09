/**
 * Session assistant. Commands are answered by code from the organization's own data. Free text needs a
 * language model through DeepSeek Harness; without a configured key and the organization's consent
 * (rule 5) the assistant says so instead of pretending.
 */
import type { Config } from '../config.js'
import { balance } from '../credits.js'
import type { Db } from '../db.js'
import { formatMoney } from '../invoicing/compute.js'
import { consentState } from '../orgs/consents.js'

export interface Reply { text: string; items?: Array<{ label: string; value: string; href?: string }> }

export const COMMANDS = [
  { cmd: '/facturer', desc: 'Déposer des rapports et préparer les factures' },
  { cmd: '/validations', desc: 'Factures qui attendent votre validation' },
  { cmd: '/solde', desc: 'Crédits restants' },
  { cmd: '/agents', desc: 'État de vos agents' },
  { cmd: '/aide', desc: 'Liste des commandes' },
]

export async function answer(db: Db, config: Config, orgId: string, plan: 'solo' | 'entreprise', text: string): Promise<Reply> {
  const command = text.trim().split(/\s+/)[0]!.toLowerCase()
  switch (command) {
    case '/aide':
      return { text: 'Voici ce que je sais faire :', items: COMMANDS.map(c => ({ label: c.cmd, value: c.desc })) }
    case '/solde': {
      const n = await balance(db, orgId)
      return { text: `Il vous reste ${n} crédit${n > 1 ? 's' : ''}. Un crédit = un rapport transformé en projet de facture.` }
    }
    case '/validations': {
      const rows = await db.all<{ id: string; number: string; total_cents: number; currency: string; name: string }>(`SELECT i.id, i.number, i.total_cents, i.currency, c.name FROM invoices i JOIN clients c ON c.id = i.client_id AND c.org_id = i.org_id
        WHERE i.org_id = ? AND i.status = 'draft' ORDER BY i.created_at LIMIT 10`, orgId)
      if (rows.length === 0) return { text: 'Aucune facture en attente de validation.' }
      return { text: `${rows.length} facture${rows.length > 1 ? 's' : ''} attend${rows.length > 1 ? 'ent' : ''} votre validation :`, items: rows.map(r => ({ label: `${r.number} · ${r.name}`, value: `${formatMoney(r.total_cents)} ${r.currency}`, href: `/validations/${r.id}` })) }
    }
    case '/agents': {
      const rows = await db.all<{ name: string; status: string }>('SELECT name, status FROM agents WHERE org_id = ? ORDER BY created_at', orgId)
      if (rows.length === 0) return { text: "Vous n'avez pas encore d'agent. Créez-en un depuis « Packs d'agents »." }
      return { text: 'Vos agents :', items: rows.map(r => ({ label: r.name, value: r.status === 'active' ? 'actif' : 'en pause' })) }
    }
    case '/facturer':
      return { text: "Déposez vos rapports d'activité (PDF, Excel ou CSV) avec le bouton « Joindre des rapports ». Je lis chaque rapport, je calcule la facture selon le contrat et je vous la présente avant tout envoi." }
    default: {
      const model = plan === 'entreprise' ? 'Claude Opus 5.5' : 'DeepSeek'
      const hasKey = plan === 'entreprise' ? config.models.anthropic : config.models.deepseek
      if (!hasKey) {
        return { text: `Les questions libres passent par un modèle de langage (${model} pour votre offre). Il n'est pas encore configuré sur ce serveur. Les commandes, elles, fonctionnent : tapez /aide.` }
      }
      if (!(await consentState(db, orgId)).external_model) {
        return { text: `Pour répondre aux questions libres, j'utilise ${model}, un fournisseur externe. Un administrateur doit d'abord l'autoriser dans Paramètres › Données et consentements.` }
      }
      return { text: `Le branchement de ${model} via DeepSeek Harness est prévu à l'étape suivante. En attendant, tapez /aide pour les commandes disponibles.` }
    }
  }
}
