/** Design screen C — check an invoice before it leaves. Nothing is sent without this validation (rule 7). */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, date, download, money, time, uuid } from '../api'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, useSession } from '../state'

interface Line { code: string; label: string; unit: string; qty: string; qty_milli: number; unit_cents: number; amount_cents: number }
interface Check { id: string; status: 'ok' | 'warning' | 'error' | 'info'; title: string; note: string }
interface Invoice {
  id: string; number: string; status: 'draft' | 'validated' | 'rejected'; currency: string; lines: Line[]; subtotal_cents: number; vat_rate_bp: number
  vat_cents: number; total_cents: number; issue_date: string; due_date: string; po_number: string; period: string | null; checks: Check[]
  created_at: string; decided_at: string | null; reject_reason: string | null; corrections: Array<{ code: string; before: string; after: string; note: string | null }>
  client: { name: string; address: string | null; nif: string | null; email: string | null }
  contract: { reference: string; payment_terms_days: number }
  document: { id: string; filename: string; report_number: string }
  agent: { name: string }
  decided_by_user: { first_name: string | null; last_name: string | null; email: string } | null
}

const ICON: Record<Check['status'], string> = { ok: '✓', warning: '!', error: '×', info: 'i' }
const unitShort = (u: string) => ({ jour: 'j', heure: 'h', 'mètre': 'm', forfait: '' } as Record<string, string>)[u] ?? u
const qtyFr = (q: string) => q.replace('.', ',')

export function InvoiceReview() {
  const { id } = useParams()
  const { me, toast } = useSession()
  const navigate = useNavigate()
  const [inv, setInv] = useState<Invoice | null>(null)
  const [mode, setMode] = useState<'view' | 'correct' | 'reject'>('view')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [next, setNext] = useState<string[]>([])
  const [key] = useState(uuid)
  const org = me?.org

  const load = useCallback(() => api.get<{ invoice: Invoice }>(`/api/invoices/${id}`).then(r => { setInv(r.invoice); setQty(Object.fromEntries(r.invoice.lines.map(l => [l.code, qtyFr(l.qty)]))) }), [id])
  useEffect(() => { void load().catch(() => setInv(null)) }, [load])
  useEffect(() => { api.get<{ invoices: Array<{ id: string }> }>('/api/invoices?status=draft').then(r => setNext(r.invoices.map(i => i.id).filter(x => x !== id))).catch(() => undefined) }, [id, inv?.status])

  const act = async (fn: () => Promise<{ invoice: Invoice }>, done: string) => {
    setBusy(true)
    try { const r = await fn(); setInv(r.invoice); setMode('view'); toast(done) }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }
  const validate = () => act(() => api.post(`/api/invoices/${id}/validate`, {}, { 'idempotency-key': key }), 'Facture validée.')
  const reject = () => act(() => api.post(`/api/invoices/${id}/reject`, { reason }), 'Facture rejetée.')
  const correct = () => act(() => api.post(`/api/invoices/${id}/correct`, { lines: Object.entries(qty).map(([code, q]) => ({ code, qty: q })), note: note || undefined }), 'Correction enregistrée.')

  const attention = useMemo(() => inv?.checks.filter(c => c.status === 'warning' || c.status === 'error').length ?? 0, [inv])
  if (!inv) return <Shell crumb="Validations" title="Facture"><div className="page empty"><span className="spinner" /></div></Shell>
  const blocking = inv.checks.some(c => c.status === 'error')
  const who = inv.decided_by_user ? [inv.decided_by_user.first_name, inv.decided_by_user.last_name].filter(Boolean).join(' ') || inv.decided_by_user.email : ''

  return (
    <Shell crumb={`Validations › ${inv.number}`} title={inv.status === 'draft' ? 'Vérifier la facture avant envoi' : inv.status === 'validated' ? 'Facture validée' : 'Facture rejetée'}>
      <div className="page" style={{ maxWidth: 1240 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          {inv.status === 'draft' && <span className="badge alert">Brouillon</span>}
          {inv.status === 'validated' && <span className="badge green">Validée</span>}
          {inv.status === 'rejected' && <span className="badge reject">Rejetée</span>}
          <span className="small muted">Préparée par {inv.agent.name} à {time(inv.created_at)} · non envoyée</span>
        </div>
        <div className="review">
          <article className="paper" aria-label="Facture">
            <div className="spread" style={{ alignItems: 'flex-start' }}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                {org?.has_logo && <img src="/api/orgs/current/logo?size=64" width={44} height={44} alt="" />}
                <div className="small"><b style={{ fontSize: 14 }}>{org?.name}</b><div className="muted">{org?.address}</div>{org?.rccm && <div className="muted">RCCM {org.rccm}</div>}{org?.nif && <div className="muted">NIF {org.nif}</div>}</div>
              </div>
              <div className="right"><h2>FACTURE</h2><div className="mono small muted">N° {inv.number}</div></div>
            </div>
            <div className="spread" style={{ alignItems: 'flex-start', marginTop: 28, gap: 28 }}>
              <div className="grow" style={{ borderTop: '1.5px solid #16211B', paddingTop: 10 }}>
                <div className="eyebrow" style={{ color: '#4D5A52' }}>Facturé à</div>
                <b>{inv.client.name}</b><div className="small muted">{[inv.client.address, inv.client.nif && `NIF ${inv.client.nif}`].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="grow small" style={{ borderTop: '1.5px solid #16211B', paddingTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }}>
                <span className="muted">Date</span><span className="mono">{date(inv.issue_date)}</span>
                <span className="muted">Bon de commande</span><span className="mono">{inv.po_number}</span>
                <span className="muted">Échéance</span><span className="mono">{date(inv.due_date)} ({inv.contract.payment_terms_days} j)</span>
                {inv.period && <><span className="muted">Période</span><span className="mono">{inv.period}</span></>}
              </div>
            </div>
            <table style={{ marginTop: 26 }}>
              <thead><tr><th>Désignation</th><th className="num">Qté</th><th className="num">P.U. {inv.currency}</th><th className="num">Total {inv.currency}</th></tr></thead>
              <tbody>{inv.lines.map(l => (
                <tr key={l.code}>
                  <td>{l.label}<div className="tiny muted mono">{l.code}</div></td>
                  <td className="num">{mode === 'correct'
                    ? <input className="qty" aria-label={`Quantité ${l.code}`} value={qty[l.code] ?? ''} onChange={e => setQty(q => ({ ...q, [l.code]: e.target.value }))} />
                    : `${qtyFr(l.qty)} ${unitShort(l.unit)}`}</td>
                  <td className="num">{money(l.unit_cents, '').trim()}</td>
                  <td className="num">{money(l.amount_cents, '').trim()}</td>
                </tr>
              ))}</tbody>
            </table>
            <div className="totals">
              <div><span>Total HT</span><span className="mono">{money(inv.subtotal_cents, '').trim()}</span></div>
              <div><span>{inv.vat_rate_bp ? `TVA ${inv.vat_rate_bp / 100} %` : 'TVA non applicable'}</span><span className="mono">{money(inv.vat_cents, '').trim()}</span></div>
              <div className="grand"><span>Total TTC</span><span className="mono">{money(inv.total_cents, inv.currency)}</span></div>
            </div>
            {org?.bank_details && <p className="small muted" style={{ marginTop: 22, borderTop: '1px solid #E6E0D3', paddingTop: 10 }}>{org.bank_details}</p>}
            <div className="nonfiscal"><b>Document non fiscal — projet de facture.</b> La facture normalisée DGI est émise par votre dispositif électronique fiscal homologué.</div>
          </article>

          <aside className="stack">
            <div className="card checks">
              <div className="card-head"><h2 style={{ fontSize: 17 }}>Contrôles de l'agent</h2>{attention > 0 && <span className="badge alert">{attention} à vérifier</span>}</div>
              {inv.checks.map(c => (
                <div className="check" key={c.id}><span className={`check-icon ${c.status}`}>{ICON[c.status]}</span><div><div className="t">{c.title}</div><div className="n">{c.note}</div></div></div>
              ))}
              <div className="check"><span className="check-icon info"><Icon name="doc" size={13} /></span><div className="n">Source : <button className="btn ghost small" style={{ padding: 0, height: 'auto' }} onClick={() => download(`/api/documents/${inv.document.id}/file`, inv.document.filename)}><span className="mono">{inv.document.filename}</span></button> · contrat {inv.contract.reference}</div></div>
            </div>
            {inv.corrections.length > 0 && (
              <div className="card card-pad small"><div className="eyebrow">Corrections</div>{inv.corrections.map((c, i) => <div key={i}><span className="mono">{c.code}</span> : {qtyFr(c.before)} → {qtyFr(c.after)}{c.note ? ` — ${c.note}` : ''}</div>)}</div>
            )}
            <div className="card card-pad small">
              <div className="eyebrow">Envoi à</div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>{inv.client.email ?? '—'}</div>
              <div className="muted">L'envoi par e-mail n'est pas encore branché : téléchargez le PDF et transmettez-le vous-même.</div>
            </div>

            {inv.status === 'validated' && (
              <div className="success stack" style={{ gap: 8 }}>
                <b>Facture validée — {inv.number}</b>
                <span className="small">Par {who} à {inv.decided_at ? time(inv.decided_at) : ''}. Copie archivée sur le serveur.</span>
                <button className="btn primary" onClick={() => download(`/api/invoices/${inv.id}/pdf`, `${inv.number}.pdf`)}><Icon name="download" size={16} /> Télécharger le PDF</button>
                {next.length > 0 && <button className="btn" onClick={() => navigate(`/validations/${next[0]}`)}>Validation suivante ({next.length})</button>}
              </div>
            )}
            {inv.status === 'rejected' && <div className="card card-pad small"><b>Rejetée.</b> {inv.reject_reason}</div>}

            {inv.status === 'draft' && can.validate(org?.role) && mode === 'view' && (<>
              <button className="btn primary block" style={{ height: 48 }} disabled={busy || blocking} onClick={validate}><Icon name="check" size={16} /> Valider la facture</button>
              <div className="row"><button className="btn grow" onClick={() => setMode('correct')}>Corriger</button><button className="btn danger grow" onClick={() => setMode('reject')}>Rejeter</button></div>
              <button className="btn ghost small" onClick={() => download(`/api/invoices/${inv.id}/pdf`, `${inv.number}.pdf`)}><Icon name="download" size={14} /> Aperçu PDF</button>
              <p className="tiny muted" style={{ textAlign: 'center', margin: 0 }}>{blocking ? 'Un contrôle bloque la validation : corrigez ou rejetez.' : 'Rien n\'est envoyé sans votre validation.'}</p>
            </>)}
            {mode === 'correct' && (
              <div className="card card-pad stack">
                <b>Corriger les quantités</b>
                <span className="small muted">Modifiez les quantités dans la facture. Les montants sont recalculés par le code ; la correction est enregistrée.</span>
                <input className="input" placeholder="Raison (ex. jour d'arrêt non facturable)" value={note} onChange={e => setNote(e.target.value)} />
                <div className="row"><button className="btn primary grow" disabled={busy} onClick={correct}>Enregistrer</button><button className="btn" onClick={() => setMode('view')}>Annuler</button></div>
              </div>
            )}
            {mode === 'reject' && (
              <div className="card card-pad stack">
                <b>Rejeter la facture</b>
                <textarea className="input" rows={3} placeholder="Raison du rejet" value={reason} onChange={e => setReason(e.target.value)} />
                <div className="row"><button className="btn danger grow" disabled={busy || reason.trim().length < 3} onClick={reject}>Rejeter</button><button className="btn" onClick={() => setMode('view')}>Annuler</button></div>
              </div>
            )}
            {inv.status === 'draft' && !can.validate(org?.role) && <p className="small muted">Votre rôle permet de consulter cette facture, pas de la valider.</p>}
            <Link className="small" to="/validations">← Toutes les validations</Link>
          </aside>
        </div>
      </div>
    </Shell>
  )
}
