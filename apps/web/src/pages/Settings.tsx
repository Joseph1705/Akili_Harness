/** Settings: company, data and consents, team, clients and contracts, security (devices), audit log. */
import { useEffect, useRef, useState } from 'react'
import { ago, api, ApiError, money } from '../api'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, ROLE_LABEL, useSession, type Role } from '../state'

type Tab = 'company' | 'data' | 'team' | 'clients' | 'security' | 'audit'

export function Settings() {
  const { me } = useSession()
  const admin = can.configure(me?.org?.role)
  const tabs: Array<[Tab, string]> = [['company', 'Entreprise'], ['data', 'Données et consentements'], ['team', 'Équipe'], ['clients', 'Clients et contrats'], ['security', 'Sécurité'], ...(admin ? [['audit', 'Journal d\'audit'] as [Tab, string]] : [])]
  const [tab, setTab] = useState<Tab>('company')
  return (
    <Shell crumb="Compte" title="Paramètres">
      <div className="page">
        <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
        {tab === 'company' && <Company />}
        {tab === 'data' && <DataConsents />}
        {tab === 'team' && <Team />}
        {tab === 'clients' && <Clients />}
        {tab === 'security' && <Security />}
        {tab === 'audit' && <Audit />}
      </div>
    </Shell>
  )
}

function useRun() {
  const { toast } = useSession()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await fn(); if (ok) toast(ok) } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }
  return { busy, run }
}

function Company() {
  const { me, refresh, bumpLogo, logoVersion } = useSession()
  const org = me!.org!
  const admin = can.configure(org.role)
  const [f, setF] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const { busy, run } = useRun()
  useEffect(() => {
    setF({ name: org.name, sector: org.sector ?? '', city: org.city ?? '', province: org.province ?? '', rccm: org.rccm ?? '', id_nat: org.id_nat ?? '', nif: org.nif ?? '', address: org.address ?? '', vat_status: org.vat_status, bank_details: org.bank_details ?? '' })
  }, [org])
  const set = (k: string) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const nn = (v?: string) => (v && v.trim() ? v.trim() : null)
  const save = () => run(async () => {
    await api.patch('/api/orgs/current', { name: f.name, sector: nn(f.sector), city: nn(f.city), province: nn(f.province), rccm: nn(f.rccm), id_nat: nn(f.id_nat), nif: nn(f.nif), address: nn(f.address), vat_status: f.vat_status, bank_details: nn(f.bank_details) })
    await refresh()
  }, 'Enregistré.')
  const upload = (file: File) => run(async () => { const fd = new FormData(); fd.append('file', file); await api.post('/api/orgs/current/logo', fd); await refresh(); bumpLogo() }, 'Logo enregistré.')
  return (
    <div className="card card-pad stack" style={{ maxWidth: 820 }}>
      <div className="row">
        {org.has_logo ? <img src={`/api/orgs/current/logo?size=128&v=${logoVersion}`} width={64} height={64} alt="Logo" /> : <span className="avatar" style={{ width: 64, height: 64, fontSize: 20 }}>{org.name.slice(0, 2).toUpperCase()}</span>}
        <div className="grow"><b>{org.name}</b><div className="small muted">Offre {org.plan === 'solo' ? 'Entrepreneur individuel (DeepSeek)' : 'Entreprise (Claude Opus 5.5)'}</div></div>
        {admin && <><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} /><button className="btn small" onClick={() => fileRef.current?.click()}><Icon name="upload" size={14} /> Logo</button></>}
      </div>
      <div className="form-grid">
        <div className="field full"><label>Raison sociale</label><input className="input" value={f.name ?? ''} onChange={set('name')} disabled={!admin} /></div>
        <div className="field"><label>Secteur</label><input className="input" value={f.sector ?? ''} onChange={set('sector')} disabled={!admin} /></div>
        <div className="field"><label>Assujetti à la TVA</label><select className="input" value={f.vat_status} onChange={set('vat_status')} disabled={!admin}><option value="yes">Oui</option><option value="no">Non</option><option value="unknown">Je ne sais pas</option></select></div>
        <div className="field"><label>Ville</label><input className="input" value={f.city ?? ''} onChange={set('city')} disabled={!admin} /></div>
        <div className="field"><label>Province</label><input className="input" value={f.province ?? ''} onChange={set('province')} disabled={!admin} /></div>
        <div className="field"><label>RCCM</label><input className="input mono" value={f.rccm ?? ''} onChange={set('rccm')} disabled={!admin} /></div>
        <div className="field"><label>NIF</label><input className="input mono" value={f.nif ?? ''} onChange={set('nif')} disabled={!admin} /></div>
        <div className="field"><label>Id. Nat.</label><input className="input mono" value={f.id_nat ?? ''} onChange={set('id_nat')} disabled={!admin} /></div>
        <div className="field"><label>Adresse</label><input className="input" value={f.address ?? ''} onChange={set('address')} disabled={!admin} /></div>
        <div className="field full"><label>Mention de paiement (bas de facture)</label><input className="input" value={f.bank_details ?? ''} onChange={set('bank_details')} disabled={!admin} /></div>
      </div>
      {admin && <div><button className="btn primary" disabled={busy} onClick={save}>Enregistrer</button></div>}
    </div>
  )
}

function DataConsents() {
  const { me } = useSession()
  const admin = can.configure(me?.org?.role)
  const [c, setC] = useState<{ terms: boolean; privacy: boolean; external_model: boolean } | null>(null)
  const { busy, run } = useRun()
  useEffect(() => { void api.get<typeof c>('/api/orgs/current/consents').then(setC) }, [])
  const provider = me?.org?.plan === 'solo' ? 'DeepSeek' : 'Anthropic (Claude Opus 5.5)'
  return (
    <div className="card card-pad stack" style={{ maxWidth: 820 }}>
      <div><b>Mode de données : {me?.org?.data_mode === 'souverain' ? 'Souverain' : 'Standard'}</b><div className="small muted">Vos fichiers sont chiffrés sur ce serveur ({me?.app.hostingLabel}), avec une clé propre à votre organisation.</div></div>
      <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
        <div className="spread">
          <div><b>Fournisseur de modèle externe — {provider}</b><div className="small muted">Utilisé seulement pour les questions libres à l'assistant. Les factures sont préparées sans lui. Consentement {c?.external_model ? 'donné' : 'non donné'}.</div></div>
          {admin && c && <button className={`btn small${c.external_model ? ' danger' : ' primary'}`} disabled={busy} onClick={() => run(async () => setC(await api.post('/api/orgs/current/consents', { type: 'external_model', granted: !c.external_model })), 'Consentement enregistré.')}>{c.external_model ? 'Retirer' : 'Autoriser'}</button>}
        </div>
      </div>
      <div className="small muted">Conditions d'utilisation : {c?.terms ? 'acceptées' : 'non acceptées'} · Politique de confidentialité : {c?.privacy ? 'acceptée' : 'non acceptée'}. Chaque décision est horodatée et versionnée.</div>
    </div>
  )
}

function Team() {
  const { me } = useSession()
  const admin = can.configure(me?.org?.role)
  const [members, setMembers] = useState<Array<{ id: string; email: string; first_name: string | null; last_name: string | null; role: Role }>>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const { busy, run } = useRun()
  const load = () => api.get<{ members: typeof members }>('/api/orgs/current/members').then(r => setMembers(r.members))
  useEffect(() => { void load() }, [])
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card">
        <table className="table"><thead><tr><th>Personne</th><th>Rôle</th></tr></thead>
          <tbody>{members.map(m => <tr key={m.id}><td><b>{[m.first_name, m.last_name].filter(Boolean).join(' ') || '—'}</b><div className="small muted">{m.email}</div></td><td>{ROLE_LABEL[m.role]}</td></tr>)}</tbody></table>
      </div>
      {admin && (
        <div className="card card-pad stack">
          <b>Inviter une personne</b>
          <div className="form-grid">
            <input className="input" type="email" placeholder="adresse@entreprise.cd" value={email} onChange={e => setEmail(e.target.value)} />
            <select className="input" value={role} onChange={e => setRole(e.target.value as Role)}><option value="admin">Administrateur</option><option value="operator">Opérateur</option><option value="accountant">Comptable externe (voit et valide)</option><option value="reader">Lecteur</option></select>
          </div>
          <div><button className="btn primary" disabled={busy || !email} onClick={() => run(async () => { await api.post('/api/orgs/current/members', { email, role }); setEmail(''); await load() }, 'Invitation enregistrée. La personne se connecte avec son adresse e-mail.')}>Inviter</button></div>
        </div>
      )}
    </div>
  )
}

function Clients() {
  const [clients, setClients] = useState<Array<{ id: string; name: string; nif: string | null; email: string | null; vat_applicable: number; contracts: Array<{ id: string; reference: string; po_number: string; payment_terms_days: number; currency: string; rates: Array<{ code: string; label: string; unit: string; unit_price: string; max_qty?: string }> }> }> | null>(null)
  useEffect(() => { void api.get<{ clients: NonNullable<typeof clients> }>('/api/clients').then(r => setClients(r.clients)) }, [])
  if (!clients) return <div className="empty"><span className="spinner" /></div>
  if (clients.length === 0) return <div className="card empty">Aucun client. Les contrats et grilles tarifaires servent à calculer les factures.</div>
  return (
    <div className="stack">
      {clients.map(c => c.contracts.map(k => (
        <div className="card" key={k.id}>
          <div className="card-head"><div><b>{c.name}</b> <span className="small muted">· NIF {c.nif ?? '—'} · {c.vat_applicable ? 'TVA applicable' : 'TVA non applicable'}</span></div><span className="small mono">{k.reference} · {k.po_number} · {k.payment_terms_days} j</span></div>
          <table className="table"><thead><tr><th>Code</th><th>Prestation</th><th>Unité</th><th className="right">Prix unitaire</th><th className="right">Plafond</th></tr></thead>
            <tbody>{k.rates.map(r => <tr key={r.code}><td className="mono small">{r.code}</td><td>{r.label}</td><td className="small">{r.unit}</td><td className="right mono">{money(Math.round(Number(r.unit_price) * 100), k.currency)}</td><td className="right mono small">{r.max_qty ?? '—'}</td></tr>)}</tbody></table>
        </div>
      )))}
    </div>
  )
}

function Security() {
  const { refresh } = useSession()
  const [sessions, setSessions] = useState<Array<{ id: string; user_agent: string; created_at: string; last_seen_at: string; current: boolean }>>([])
  const { busy, run } = useRun()
  const load = () => api.get<{ sessions: typeof sessions }>('/api/auth/sessions').then(r => setSessions(r.sessions))
  useEffect(() => { void load() }, [])
  const device = (ua: string) => /mobile|android|iphone/i.test(ua) ? 'Téléphone' : /windows/i.test(ua) ? 'Ordinateur Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Ordinateur Linux' : 'Appareil'
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card">
        <div className="card-head"><b>Appareils connectés</b></div>
        {sessions.map(s => (
          <div className="list-row" key={s.id}>
            <div className="grow"><b>{device(s.user_agent)}</b> {s.current && <span className="badge green">Cet appareil</span>}<div className="tiny muted">Connecté {ago(s.created_at)} · actif {ago(s.last_seen_at)}</div></div>
            {!s.current && <button className="btn small danger" disabled={busy} onClick={() => run(async () => { await api.del(`/api/auth/sessions/${s.id}`); await load() }, 'Appareil déconnecté.')}>Déconnecter</button>}
          </div>
        ))}
      </div>
      <div className="small muted">Connexion par code à usage unique (10 min, 5 essais). Les sessions ne dépendent pas de votre adresse IP : un changement de réseau (fibre, Starlink, 4G) ne vous déconnecte pas.</div>
      <div><button className="btn" onClick={() => run(async () => { await api.post('/api/auth/logout'); await refresh() })}><Icon name="logout" size={16} /> Se déconnecter</button></div>
    </div>
  )
}

const ACTIONS: Record<string, string> = {
  'org.created': 'Espace créé', 'org.updated': 'Paramètres modifiés', 'org.logo_updated': 'Logo modifié', 'org.onboarding_completed': 'Inscription terminée',
  'consent.recorded': 'Consentement enregistré', 'member.invited': 'Membre invité', 'credits.topup': 'Recharge de crédits', 'agent.created': 'Agent créé',
  'agent.updated': 'Agent modifié', 'agent.tested': 'Agent testé', 'document.uploaded': 'Rapport déposé', 'document.downloaded': 'Rapport téléchargé',
  'invoice.drafted': 'Projet de facture préparé', 'invoice.validated': 'Facture validée', 'invoice.rejected': 'Facture rejetée', 'invoice.corrected': 'Facture corrigée',
  'invoice.pdf_downloaded': 'PDF téléchargé', 'demo.loaded': 'Données de démonstration chargées', 'auth.session_revoked': 'Appareil déconnecté',
}

function Audit() {
  const [entries, setEntries] = useState<Array<{ id: number; action: string; target_type: string | null; target_id: string | null; email: string | null; created_at: string; detail: Record<string, unknown> | null }>>([])
  useEffect(() => { void api.get<{ entries: typeof entries }>('/api/audit').then(r => setEntries(r.entries)) }, [])
  return (
    <div className="card">
      <table className="table"><thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Objet</th></tr></thead>
        <tbody>{entries.map(e => <tr key={e.id}><td className="small muted">{new Date(e.created_at).toLocaleString('fr-FR')}</td><td className="small">{e.email ?? 'Agent'}</td><td>{ACTIONS[e.action] ?? e.action}</td><td className="small mono muted">{e.target_type} {e.target_id?.slice(0, 8)}</td></tr>)}</tbody></table>
    </div>
  )
}
