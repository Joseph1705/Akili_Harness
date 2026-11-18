/**
 * Platform administration (our team only, AKILI_PLATFORM_ADMINS): organizations and balances, credit packages
 * and prices, SasPay payments, the credit ledger, allocations, refunds and corrections (all audited), and the
 * internal cost of AI with evaluations. Nothing here is visible to customers.
 */
import { useCallback, useEffect, useState } from 'react'
import { ago, api, ApiError, money, uuid } from '../api'
import { Shell } from '../components/Shell'
import { useSession } from '../state'

interface Org { id: string; name: string; kind: string; plan: string; city: string | null; created_at: string; onboarding_done_at: string | null; balance: number; total_purchased: number; total_consumed: number; members: number; documents: number; documents_30d: number; owner_email: string | null }
interface Pack { id: string; name: string; credits: number; price_cents: number | null; currency: 'USD' | 'CDF'; description: string | null; active: boolean; promotional: boolean; sort_order: number }
interface Payment { id: string; org_name: string; package_name: string; credits: number; amount_cents: number; currency: string; status: string; provider_reference: string | null; provider_status: string | null; failure_reason: string | null; created_at: string; credited_at: string | null; created_by_email: string }
interface Tx { id: string; org_name: string; type: string; amount: number; balance_before: number; balance_after: number; operation_key: string; payment_reference: string | null; reason: string | null; created_at: string; actor_email: string | null }
interface Ai { days: Array<{ day: string; runs: number; cost_micro_usd: number; errors: number }>; models: Array<{ provider: string; model: string; runs: number; cost_micro_usd: number; tokens: number }>; orgs: Array<{ name: string; runs: number; cost_micro_usd: number; extractions: number }>; errors: Array<{ purpose: string; provider: string | null; model: string | null; error: string | null; created_at: string }>; evals: Array<{ id: string; method: string; cases: number; score: string; created_at: string }> }

type Tab = 'orgs' | 'packages' | 'payments' | 'ledger' | 'ai'
const TX: Record<string, string> = { purchase: 'Achat', consumption: 'Facture générée', refund: 'Remboursement', admin_allocation: 'Allocation', admin_correction: 'Correction' }
const usd = (micro: number) => `${(micro / 1_000_000).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`

export function Platform() {
  const [tab, setTab] = useState<Tab>('orgs')
  return (
    <Shell crumb="Plateforme" title="Administration">
      <div className="page stack" style={{ gap: 16 }}>
        <div className="tabs" role="tablist" style={{ flexWrap: 'wrap' }}>{([['orgs', 'Organisations'], ['packages', 'Paquets et prix'], ['payments', 'Paiements'], ['ledger', 'Registre des crédits'], ['ai', 'Coûts IA et évaluations']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
        {tab === 'orgs' && <Orgs />}
        {tab === 'packages' && <Packages />}
        {tab === 'payments' && <Payments />}
        {tab === 'ledger' && <Ledger />}
        {tab === 'ai' && <AiCosts />}
      </div>
    </Shell>
  )
}

function Orgs() {
  const { toast } = useSession()
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [target, setTarget] = useState<Org | null>(null)
  const [action, setAction] = useState<'credits' | 'refunds' | 'corrections'>('credits')
  const [amount, setAmount] = useState('100')
  const [text, setText] = useState('')
  const [promo, setPromo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const load = () => api.get<{ orgs: Org[] }>('/api/platform/orgs').then(r => setOrgs(r.orgs))
  useEffect(() => { void load() }, [])

  async function submit() {
    if (!target) return
    setBusy(true)
    try {
      const n = Number(amount)
      const body = action === 'credits' ? { credits: n, ref: text, promotional: promo } : action === 'refunds' ? { credits: n, reason: text } : { amount: n, reason: text }
      await api.post(`/api/platform/orgs/${target.id}/${action}`, body, { 'idempotency-key': uuid() })
      toast(`${action === 'credits' ? 'Allocation' : action === 'refunds' ? 'Remboursement' : 'Correction'} enregistrée pour ${target.name}.`)
      setTarget(null); setText(''); await load()
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  const shown = (orgs ?? []).filter(o => `${o.name} ${o.owner_email ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="spread"><input className="input" style={{ maxWidth: 360 }} placeholder="Rechercher une entreprise ou un e-mail" value={filter} onChange={e => setFilter(e.target.value)} /><span className="small muted">{orgs?.length ?? 0} organisations</span></div>
      {target && (
        <div className="card card-pad stack" style={{ maxWidth: 620 }}>
          <b>{target.name} — solde {target.balance}</b>
          <div className="segmented">{([['credits', 'Allouer'], ['refunds', 'Rembourser'], ['corrections', 'Corriger']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={action === k} onClick={() => setAction(k)}>{l}</button>)}</div>
          <div className="form-grid">
            <div className="field"><label>{action === 'corrections' ? 'Crédits (négatif pour retirer)' : 'Crédits'}</label><input className="input mono" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(action === 'corrections' ? /[^\d-]/g : /\D/g, ''))} /></div>
            <div className="field"><label>{action === 'credits' ? 'Référence du paiement ou motif' : 'Motif (obligatoire)'}</label><input className="input" value={text} onChange={e => setText(e.target.value)} placeholder={action === 'credits' ? 'M-PESA, virement, lancement…' : 'Extraction erronée, double saisie…'} /></div>
          </div>
          {action === 'credits' && <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={promo} onChange={e => setPromo(e.target.checked)} /> Crédits promotionnels</label>}
          <span className="tiny muted">Rien n'est jamais supprimé : chaque opération est une écriture du registre, avec son auteur, et figure au journal d'audit.</span>
          <div className="row"><button className="btn primary" disabled={busy || !Number(amount) || text.trim().length < 3} onClick={submit}>Enregistrer</button><button className="btn" onClick={() => setTarget(null)}>Annuler</button></div>
        </div>
      )}
      <div className="card">
        <table className="table">
          <thead><tr><th>Organisation</th><th>Propriétaire</th><th className="right">Documents (30 j)</th><th className="right">Achetés / utilisés</th><th className="right">Solde</th><th /></tr></thead>
          <tbody>{shown.map(o => (
            <tr key={o.id}>
              <td><b>{o.name}</b><div className="tiny muted">{o.plan === 'solo' ? 'Entrepreneur' : 'Entreprise'} · {o.city ?? '—'} · inscrite {ago(o.created_at)}{o.onboarding_done_at ? '' : ' · inscription inachevée'}</div></td>
              <td className="small">{o.owner_email}</td>
              <td className="right mono">{o.documents_30d} <span className="tiny muted">/ {o.documents}</span></td>
              <td className="right mono small">{o.total_purchased} / {o.total_consumed}</td>
              <td className="right mono">{o.balance}</td>
              <td className="right"><button className="btn small" onClick={() => { setTarget(o); setText(''); setAction('credits') }}>Crédits…</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  )
}

function Packages() {
  const { toast } = useSession()
  const [packs, setPacks] = useState<Pack[] | null>(null)
  const [edit, setEdit] = useState<(Pack & { price: string }) | null>(null)
  const load = () => api.get<{ packages: Pack[] }>('/api/platform/packages').then(r => setPacks(r.packages))
  useEffect(() => { void load() }, [])
  const blank = (): Pack & { price: string } => ({ id: '', name: '', credits: 100, price_cents: null, currency: 'USD', description: '', active: false, promotional: false, sort_order: 10, price: '' })
  async function save() {
    if (!edit) return
    const price = edit.price.trim() ? Math.round(Number(edit.price.replace(/\s/g, '').replace(',', '.')) * 100) : null
    const body = { name: edit.name, credits: Number(edit.credits), price_cents: price, currency: edit.currency, description: edit.description || null, active: edit.active, promotional: edit.promotional, sort_order: Number(edit.sort_order) }
    try {
      if (edit.id) await api.put(`/api/platform/packages/${edit.id}`, body)
      else await api.post('/api/platform/packages', body)
      toast('Paquet enregistré.'); setEdit(null); await load()
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') }
  }
  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted" style={{ margin: 0 }}>Les clients voient les paquets actifs. Un paquet ne peut être mis en vente qu'avec un prix. Un achat déjà lancé garde le prix du moment.</p>
      <div><button className="btn primary small" onClick={() => setEdit(blank())}>Nouveau paquet</button></div>
      {edit && (
        <div className="card card-pad stack" style={{ maxWidth: 720 }}>
          <div className="form-grid">
            <div className="field"><label>Nom</label><input className="input" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>Crédits</label><input className="input mono" inputMode="numeric" value={String(edit.credits)} onChange={e => setEdit({ ...edit, credits: Number(e.target.value.replace(/\D/g, '') || 0) })} /></div>
            <div className="field"><label>Prix</label><input className="input mono" inputMode="decimal" value={edit.price} onChange={e => setEdit({ ...edit, price: e.target.value })} placeholder="Ex. 25,00" /></div>
            <div className="field"><label>Devise</label><select className="input" value={edit.currency} onChange={e => setEdit({ ...edit, currency: e.target.value as 'USD' | 'CDF' })}><option>USD</option><option>CDF</option></select></div>
            <div className="field full"><label>Description</label><input className="input" value={edit.description ?? ''} onChange={e => setEdit({ ...edit, description: e.target.value })} /></div>
            <div className="field"><label>Ordre d'affichage</label><input className="input mono" inputMode="numeric" value={String(edit.sort_order)} onChange={e => setEdit({ ...edit, sort_order: Number(e.target.value.replace(/\D/g, '') || 0) })} /></div>
          </div>
          <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> En vente</label>
          <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={edit.promotional} onChange={e => setEdit({ ...edit, promotional: e.target.checked })} /> Paquet promotionnel</label>
          <div className="row"><button className="btn primary" onClick={save}>Enregistrer</button><button className="btn" onClick={() => setEdit(null)}>Annuler</button></div>
        </div>
      )}
      <div className="card">
        <table className="table"><thead><tr><th>Paquet</th><th className="right">Crédits</th><th className="right">Prix</th><th>État</th><th /></tr></thead>
          <tbody>{packs?.map(p => (
            <tr key={p.id}><td><b>{p.name}</b>{p.promotional && <span className="badge alert" style={{ marginLeft: 6 }}>Promotion</span>}<div className="tiny muted">{p.description}</div></td>
              <td className="right mono">{p.credits.toLocaleString('fr-FR')}</td>
              <td className="right mono">{p.price_cents != null ? money(p.price_cents, p.currency) : <span className="muted">sans prix</span>}</td>
              <td><span className={`badge ${p.active ? 'green' : 'neutral'}`}>{p.active ? 'En vente' : 'Inactif'}</span></td>
              <td className="right"><button className="btn small" onClick={() => setEdit({ ...p, price: p.price_cents != null ? (p.price_cents / 100).toFixed(2) : '' })}>Modifier</button></td></tr>
          ))}</tbody></table>
      </div>
    </div>
  )
}

function Payments() {
  const { toast } = useSession()
  const [data, setData] = useState<{ payments: Payment[]; events: Array<{ id: number; event_type: string | null; signature_valid: boolean; result: string | null; received_at: string }> } | null>(null)
  const [status, setStatus] = useState('')
  const load = useCallback(() => api.get<NonNullable<typeof data>>(`/api/platform/payments${status ? `?status=${status}` : ''}`).then(setData), [status])
  useEffect(() => { void load() }, [load])
  return (
    <div className="stack" style={{ gap: 14 }}>
      <select className="input" style={{ maxWidth: 240 }} value={status} onChange={e => setStatus(e.target.value)} aria-label="Statut"><option value="">Tous les paiements</option><option value="pending">En attente</option><option value="succeeded">Payés</option><option value="failed">Échecs</option><option value="expired">Expirés</option></select>
      <div className="card">
        <table className="table"><thead><tr><th>Date</th><th>Organisation</th><th>Paquet</th><th>Statut SasPay</th><th className="right">Montant</th><th /></tr></thead>
          <tbody>{data?.payments.map(p => (
            <tr key={p.id}><td className="small muted">{new Date(p.created_at).toLocaleString('fr-FR')}</td>
              <td><b>{p.org_name}</b><div className="tiny muted">{p.created_by_email}</div></td>
              <td className="small">{p.package_name} · {p.credits}</td>
              <td><span className={`badge ${p.status === 'succeeded' ? 'green' : p.status === 'pending' ? 'alert' : p.status === 'failed' ? 'reject' : 'neutral'}`}>{p.status}</span><div className="tiny muted mono">{p.provider_status ?? ''} {p.provider_reference ?? ''}</div>{p.failure_reason && <div className="tiny muted">{p.failure_reason}</div>}</td>
              <td className="right mono">{money(p.amount_cents, p.currency)}</td>
              <td className="right">{p.status === 'pending' && <button className="btn small" onClick={async () => { try { await api.post(`/api/platform/payments/${p.id}/verify`); toast('Vérifié auprès de SasPay.'); await load() } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } }}>Vérifier</button>}</td></tr>
          ))}</tbody></table>
      </div>
      <div className="card"><div className="card-head"><b>Notifications SasPay reçues</b></div>
        <table className="table"><thead><tr><th>Reçue</th><th>Événement</th><th>Signature</th><th>Résultat</th></tr></thead>
          <tbody>{data?.events.map(e => <tr key={e.id}><td className="small muted">{ago(e.received_at)}</td><td className="mono small">{e.event_type ?? '—'}</td><td><span className={`badge ${e.signature_valid ? 'green' : 'reject'}`}>{e.signature_valid ? 'valide' : 'refusée'}</span></td><td className="small">{e.result}</td></tr>)}</tbody></table>
      </div>
    </div>
  )
}

function Ledger() {
  const [rows, setRows] = useState<Tx[] | null>(null)
  const [type, setType] = useState('')
  useEffect(() => { void api.get<{ transactions: Tx[] }>(`/api/platform/transactions${type ? `?type=${type}` : ''}`).then(r => setRows(r.transactions)) }, [type])
  return (
    <div className="stack" style={{ gap: 14 }}>
      <select className="input" style={{ maxWidth: 240 }} value={type} onChange={e => setType(e.target.value)} aria-label="Type"><option value="">Tous les types</option>{Object.entries(TX).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <div className="card">
        <table className="table"><thead><tr><th>Date</th><th>Organisation</th><th>Type</th><th>Détail</th><th className="right">Crédits</th><th className="right">Solde</th></tr></thead>
          <tbody>{rows?.map(t => (
            <tr key={t.id}><td className="small muted">{new Date(t.created_at).toLocaleString('fr-FR')}</td><td>{t.org_name}</td><td>{TX[t.type] ?? t.type}</td>
              <td className="small">{t.reason ?? t.payment_reference ?? ''}<div className="tiny muted mono">{t.operation_key}{t.actor_email ? ` · ${t.actor_email}` : ''}</div></td>
              <td className="right mono">{t.amount > 0 ? `+${t.amount}` : t.amount}</td><td className="right mono small">{t.balance_before} → {t.balance_after}</td></tr>
          ))}</tbody></table>
      </div>
    </div>
  )
}

function AiCosts() {
  const { toast } = useSession()
  const [ai, setAi] = useState<Ai | null>(null)
  const [running, setRunning] = useState(false)
  const load = () => api.get<Ai>('/api/platform/ai').then(setAi)
  useEffect(() => { void load() }, [])
  const total = ai?.days.reduce((a, d) => a + Number(d.cost_micro_usd), 0) ?? 0
  async function evalLocal() {
    setRunning(true)
    try { const r = await api.post<{ score: number; cases: number }>('/api/platform/evals/extraction', { method: 'local' }); toast(`Lecture locale : ${(r.score * 100).toFixed(1)} % sur ${r.cases} documents.`); await load() }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setRunning(false) }
  }
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="stat-grid">
        <div className="card stat"><span className="eyebrow">Coût IA (30 j, interne)</span><span className="big" style={{ fontSize: 28 }}>{usd(total)}</span><span className="small muted">Estimation aux prix publics des fournisseurs ; à rapprocher de leurs factures.</span></div>
        <div className="card stat"><span className="eyebrow">Exécutions (30 j)</span><span className="big">{ai?.days.reduce((a, d) => a + d.runs, 0) ?? '–'}</span><span className="small muted">Erreurs : {ai?.days.reduce((a, d) => a + d.errors, 0) ?? 0}</span></div>
      </div>
      <div className="card"><div className="card-head"><b>Par modèle</b></div>
        <table className="table"><thead><tr><th>Modèle</th><th className="right">Exécutions</th><th className="right">Jetons</th><th className="right">Coût</th></tr></thead>
          <tbody>{ai?.models.map(m => <tr key={`${m.provider}/${m.model}`}><td className="mono small">{m.provider}/{m.model}</td><td className="right mono">{m.runs}</td><td className="right mono">{Number(m.tokens).toLocaleString('fr-FR')}</td><td className="right mono">{usd(Number(m.cost_micro_usd))}</td></tr>)}</tbody></table>
      </div>
      <div className="card"><div className="card-head"><b>Par organisation</b></div>
        <table className="table"><thead><tr><th>Organisation</th><th className="right">Exécutions</th><th className="right">Lectures</th><th className="right">Coût</th></tr></thead>
          <tbody>{ai?.orgs.map(o => <tr key={o.name}><td>{o.name}</td><td className="right mono">{o.runs}</td><td className="right mono">{o.extractions}</td><td className="right mono">{usd(Number(o.cost_micro_usd))}</td></tr>)}</tbody></table>
      </div>
      <div className="card card-pad stack">
        <div className="spread"><b>Évaluations de la lecture des documents</b><button className="btn small" disabled={running} onClick={evalLocal}>{running ? <span className="spinner" /> : 'Évaluer la lecture locale'}</button></div>
        {ai?.evals.map(e => <span key={e.id} className="small">{new Date(e.created_at).toLocaleString('fr-FR')} · {e.method === 'local' ? 'lecture locale' : 'modèle'} · {(Number(e.score) * 100).toFixed(1)} % sur {e.cases} documents</span>)}
      </div>
      {ai && ai.errors.length > 0 && <div className="card"><div className="card-head"><b>Dernières erreurs</b></div>
        <table className="table"><tbody>{ai.errors.map((e, i) => <tr key={i}><td className="small muted">{ago(e.created_at)}</td><td className="small">{e.purpose}</td><td className="mono small">{e.model ?? '—'}</td><td className="small">{e.error}</td></tr>)}</tbody></table></div>}
    </div>
  )
}
