/** Invoice history: search, filters, totals; manual invoices cost no credit. */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, date, money, uuid } from '../api'
import { emptyInvoice, InvoiceForm, toPayload, type ClientOption, type InvoiceInput } from '../components/InvoiceForm'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, useSession } from '../state'

interface Row {
  id: string; number: string; status: 'draft' | 'validated' | 'rejected'; source: 'report' | 'document' | 'manual'; total_cents: number; currency: string
  issue_date: string; due_date: string; client_name: string; reference: string | null; po_number: string | null; payment_status: 'unpaid' | 'partial' | 'paid'
  amount_paid_cents: number; overdue: boolean; attention: number
}
interface Summary { currency: string; count: number; total_cents: number; due_cents: number }

export const STATUS_LABEL = { draft: 'À valider', validated: 'Validée', rejected: 'Rejetée' } as const
export const PAYMENT_LABEL = { unpaid: 'Non payée', partial: 'Partiellement payée', paid: 'Payée' } as const
export const SOURCE_LABEL = { report: 'Rapport', document: 'Document', manual: 'Saisie' } as const

export function Invoices() {
  const { me } = useSession()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [summary, setSummary] = useState<Summary[]>([])
  const [f, setF] = useState({ q: '', status: '', payment: '', source: '', overdue: false, from: '', to: '' })

  useEffect(() => {
    const t = window.setTimeout(() => {
      const p = new URLSearchParams()
      if (f.q.trim()) p.set('q', f.q.trim())
      for (const k of ['status', 'payment', 'source', 'from', 'to'] as const) if (f[k]) p.set(k, f[k])
      if (f.overdue) p.set('overdue', '1')
      setRows(null)
      api.get<{ invoices: Row[]; summary: Summary[] }>(`/api/invoices?${p}`).then(r => { setRows(r.invoices); setSummary(r.summary) }).catch(() => setRows([]))
    }, 250)
    return () => window.clearTimeout(t)
  }, [f])

  return (
    <Shell crumb="Facturation" title="Factures" actions={can.operate(me?.org?.role) ? <Link className="btn primary small" to="/factures/nouvelle"><Icon name="plus" size={15} /> Nouvelle facture</Link> : undefined}>
      <div className="page stack" style={{ gap: 14 }}>
        <div className="filters">
          <input className="input" style={{ minWidth: 240 }} placeholder="Numéro, client, référence…" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} aria-label="Rechercher" />
          <select className="input" value={f.status} onChange={e => setF({ ...f, status: e.target.value })} aria-label="Statut"><option value="">Tous les statuts</option><option value="draft">À valider</option><option value="validated">Validées</option><option value="rejected">Rejetées</option></select>
          <select className="input" value={f.payment} onChange={e => setF({ ...f, payment: e.target.value })} aria-label="Paiement"><option value="">Tous les paiements</option><option value="unpaid">Non payées</option><option value="partial">Partiellement payées</option><option value="paid">Payées</option></select>
          <select className="input" value={f.source} onChange={e => setF({ ...f, source: e.target.value })} aria-label="Origine"><option value="">Toutes origines</option><option value="report">Rapports</option><option value="document">Documents</option><option value="manual">Saisies</option></select>
          <input className="input" type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} aria-label="Du" />
          <input className="input" type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} aria-label="Au" />
          <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={f.overdue} onChange={e => setF({ ...f, overdue: e.target.checked })} /> En retard</label>
        </div>
        {summary.length > 0 && (
          <div className="stat-grid">{summary.map(s => (
            <div className="card stat" key={s.currency}><span className="eyebrow">{s.count} facture{s.count > 1 ? 's' : ''} · {s.currency}</span><span className="big" style={{ fontSize: 26 }}>{money(s.total_cents, s.currency)}</span><span className="small muted">Reste à encaisser (validées) : {money(s.due_cents, s.currency)}</span></div>
          ))}</div>
        )}
        <div className="card">
          {rows === null ? <div className="empty"><span className="spinner" /></div> : rows.length === 0 ? <div className="empty">Aucune facture ne correspond.</div> : (
            <table className="table">
              <thead><tr><th>Numéro</th><th>Client</th><th>Date</th><th>Statut</th><th>Paiement</th><th className="right">Total TTC</th><th /></tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.id}>
                  <td className="mono small">{r.number}<div className="tiny muted">{SOURCE_LABEL[r.source]}{r.reference ? ` · ${r.reference}` : ''}</div></td>
                  <td><b>{r.client_name}</b></td>
                  <td className="small">{date(r.issue_date)}<div className="tiny muted">échéance {date(r.due_date)}</div></td>
                  <td><span className={`badge ${r.status === 'validated' ? 'green' : r.status === 'rejected' ? 'reject' : 'alert'}`}>{STATUS_LABEL[r.status]}</span>{r.attention > 0 && r.status === 'draft' && <div className="tiny muted">{r.attention} point{r.attention > 1 ? 's' : ''} à vérifier</div>}</td>
                  <td>{r.status === 'validated' ? <span className={`badge ${r.payment_status === 'paid' ? 'green' : r.overdue ? 'reject' : 'neutral'}`}>{r.overdue && r.payment_status !== 'paid' ? 'En retard' : PAYMENT_LABEL[r.payment_status]}</span> : '—'}</td>
                  <td className="right mono">{money(r.total_cents, r.currency)}</td>
                  <td className="right"><Link className="btn small" to={`/validations/${r.id}`}>Ouvrir</Link></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
    </Shell>
  )
}

export function InvoiceNew() {
  const { me, toast } = useSession()
  const navigate = useNavigate()
  const [clients, setClients] = useState<ClientOption[]>([])
  const [form, setForm] = useState<InvoiceInput>(() => {
    try { const raw = localStorage.getItem('facture:nouvelle'); if (raw) return JSON.parse(raw) as InvoiceInput } catch { /* ignore */ }
    return emptyInvoice(me?.org?.currency === 'CDF' ? 'CDF' : 'USD')
  })
  const [busy, setBusy] = useState(false)
  const [key] = useState(uuid)
  useEffect(() => { api.get<{ clients: ClientOption[] }>('/api/clients').then(r => setClients(r.clients)).catch(() => undefined) }, [])
  useEffect(() => { try { localStorage.setItem('facture:nouvelle', JSON.stringify(form)) } catch { /* ignore */ } }, [form])

  async function save() {
    setBusy(true)
    try {
      const r = await api.post<{ invoice: { id: string; number: string } }>('/api/invoices', toPayload(form), { 'idempotency-key': key })
      try { localStorage.removeItem('facture:nouvelle') } catch { /* ignore */ }
      toast(`Projet de facture ${r.invoice.number} créé (aucun crédit utilisé).`)
      navigate(`/validations/${r.invoice.id}`)
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  return (
    <Shell crumb="Facturation › Nouvelle" title="Nouvelle facture">
      <div className="page stack" style={{ gap: 16, maxWidth: 1100 }}>
        <p className="muted" style={{ margin: 0 }}>Une facture saisie à la main n'utilise aucun crédit. Les montants sont recalculés par l'application ; le numéro définitif est attribué à la validation.</p>
        <InvoiceForm value={form} onChange={setForm} clients={clients} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => setForm(emptyInvoice(form.currency))}>Effacer</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spinner" /> : 'Créer le projet de facture'}</button>
        </div>
      </div>
    </Shell>
  )
}
