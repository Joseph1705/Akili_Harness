/** Agent packs (directive 6.1). Only the invoicing pack runs in this version; the others are announced. */
import { randomUUID } from 'node:crypto'
import { now, type Db } from '../db.js'

export interface Pack {
  id: string
  name: string
  description: string
  meta: string
  icon: 'doc' | 'bank' | 'pay' | 'cart' | 'shield' | 'mail'
  available: boolean
  defaultAgentName: string
}

export const PACKS: Pack[] = [
  { id: 'facturation-sous-traitance', name: 'Facturation', icon: 'doc', available: true, defaultAgentName: 'Agent Facturation',
    description: "Prépare les factures depuis les rapports d'activité et les bons de commande. Vérifie TVA, NIF et plafonds du contrat.", meta: '6 contrôles · TVA 16 %' },
  { id: 'rapprochement-bancaire', name: 'Rapprochement bancaire', icon: 'bank', available: false, defaultAgentName: 'Agent Banque',
    description: 'Compare relevés et grand livre, propose les écritures manquantes.', meta: 'Bientôt · plan OHADA' },
  { id: 'paie-cnss', name: 'Paie & CNSS', icon: 'pay', available: false, defaultAgentName: 'Agent Paie',
    description: "Calcule les bulletins, les cotisations CNSS et l'IPR chaque mois.", meta: 'Bientôt · barèmes 2026' },
  { id: 'achats-fournisseurs', name: 'Achats & fournisseurs', icon: 'cart', available: false, defaultAgentName: 'Agent Achats',
    description: 'Contrôle les factures fournisseurs contre les bons de commande.', meta: "Bientôt · 3 niveaux d'accord" },
  { id: 'conformite-sous-traitance', name: 'Conformité sous-traitance', icon: 'shield', available: false, defaultAgentName: 'Agent Conformité',
    description: "Suit les attestations, échéances et dossiers exigés par les donneurs d'ordre miniers.", meta: 'Bientôt · alertes à J-30' },
  { id: 'courrier-administratif', name: 'Courrier administratif', icon: 'mail', available: false, defaultAgentName: 'Agent Courrier',
    description: 'Rédige et classe les lettres, relances et réponses aux administrations.', meta: 'Bientôt · modèles FR / EN' },
]

export function packById(id: string): Pack | undefined {
  return PACKS.find(p => p.id === id)
}

export function createAgent(db: Db, orgId: string, packId: string, name: string, language: string): string {
  const id = randomUUID()
  db.prepare('INSERT INTO agents (id, org_id, pack_id, name, language, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, orgId, packId, name, language, now())
  return id
}
