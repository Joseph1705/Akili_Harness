/**
 * One invoice. Draft: check, correct, validate or reject (rule 7: nothing leaves without this validation).
 * Validated: PDF, customer payments, share links, sending by e-mail. Always "Document non fiscal" (rule 8).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, date, download, money, time, uuid } from '../api'
import { InvoiceForm, toPayload, type ClientOption, type InvoiceInput } from '../components/InvoiceForm'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, useSession } from '../state'
import { PAYMENT_LABEL, SOURCE_LABEL } from './Invoices'

interface Line { code: string; label: string; unit: string; qty: string; qty_milli: number; unit_cents: number; amount_cents: number }
interface Check { id: string; status: 'ok' | 'warning' | 'error' | 'info'; title: string; note: string }
interface Invoice {
  id: string; number: string; status: 'draft' | 'validated' | 'rejected'; source: 'report' | 'document' | 'manual'; currency: string; lines: Line[]
  subtotal_cents: number; discount_cents: number; vat_rate_bp: number; vat_cents: number; total_cents: number; issue_date: string; due_date: string
  po_number: string | null; reference: string | null; period: string | null; notes: string | null; checks: Check[]
  created_at: string; decided_at: string | null; reject_reason: string | null; corrections: Array<{ code: string; before: string; after: string; note: string | null }>
  client: { id: string; name: string; address: string | null; nif: string | null; email: string | null; vat_applicable: boolean }
  contract: { reference: string; payment_terms_days: number } | null
  document: { id: string; filename: string } | null
  agent: { name: string } | null
  decided_by_user: { first_name: string | null; last_name: string | null; email: string } | null
  payment_status: 'unpaid' | 'partial' | 'paid'; amount_paid_cents: number; balance_due_cents: number; overdue: boolean
}
interface Payment { id: string; amount_cents: number; reversal_of: string | null; paid_on: string; method: string | null; note: string | null; created_by_email: string; reversed: boolean }
interface Share { id: string; expires_at: string; revoked_at: string | null; views: number; created_at: string }

const ICON: Record<Check['status'], string> = { ok: '✓', warning: '!', error: '×', info: 'i' }
const METHODS: Record<string, string> = { virement: 'Virement', mobile_money: 'Mobile money', especes: 'Espèces', cheque: 'Chèque', carte: 'Carte', autre: 'Autre' }
const unitShort = (u: string) => ({ jour: 'j', heure: 'h', 'mètre': 'm', forfait: '' } as Record<string, string>)[u] ?? u
const qtyFr = (q: string) => q.replace('.', ',')

function toForm(inv: Invoice): InvoiceInput {
  return {
    client: { id: inv.client.id }, reference: inv.reference, po_number: inv.po_number, period: inv.period, issue_date: inv.issue_date, due_date: inv.due_date,
    currency: inv.currency === 'CDF' ? 'CDF' : 'USD', vat_rate_bp: inv.vat_rate_bp, notes: inv.notes,
    discount: inv.discount_cents ? { type: 'amount', value: (inv.discount_cents / 100).toFixed(2) } : null,
    lines: inv.lines.map(l => ({ description: l.label, quantity: l.qty, unit: l.unit, unit_price: (l.unit_cents / 100).toFixed(2) })),
  }
}

export function InvoiceReview() {
  const { id } = useParams()
  const { me, toast } = useSession()
  const navigate = useNavigate()
  const [inv, setInv] = useState<Invoice | null>(null)
  const [mode, setMode] = useState<'view' | 'correct' | 'reject' | 'edit'>('view')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [form, setForm] = useState<InvoiceInput | null>(null)
  const [clients, setClients] = useState<ClientOption[]>([])
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
  const saveEdit = () => form && act(() => api.put(`/api/invoices/${id}`, toPayload(form)), 'Facture modifiée et recalculée.')
  const startEdit = () => { if (!inv) return; setForm(toForm(inv)); setMode('edit'); api.get<{ clients: ClientOption[] }>('/api/clients').then(r => setClients(r.clients)).catch(() => undefined) }

  const attention = useMemo(() => inv?.checks.filter(c => c.status === 'warning' || c.status === 'error').length ?? 0, [inv])
  if (!inv) return <Shell crumb="Factures" title="Facture"><div className="page empty"><span className="spinner" /></div></Shell>
  const blocking = inv.checks.some(c => c.status === 'error')
  const who = inv.decided_by_user ? [inv.decided_by_user.first_name, inv.decided_by_user.last_name].filter(Boolean).join(' ') || inv.decided_by_user.email : ''
  const validator = can.validate(org?.role)

  return (
    <Shell crumb={`Factures › ${inv.number}`} title={inv.status === 'draft' ? 'Vérifier la facture avant envoi' : inv.status === 'validated' ? 'Facture validée' : 'Facture rejetée'}>
      <div className="page" style={{ maxWidth: 1240 }}>
        <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          {inv.status === 'draft' && <span className="badge alert">Brouillon</span>}
          {inv.status === 'validated' && <span className="badge green">Validée</span>}
          {inv.status === 'rejected' && <span className="badge reject">Rejetée</span>}
          {inv.status === 'validated' && <span className={`badge ${inv.payment_status === 'paid' ? 'green' : inv.overdue ? 'reject' : 'neutral'}`}>{inv.overdue && inv.payment_status !== 'paid' ? 'En retard' : PAYMENT_LABEL[inv.payment_status]}</span>}
          <span className="small muted">{SOURCE_LABEL[inv.source]}{inv.agent ? ` · préparée par ${inv.agent.name}` : ''} · {date(inv.created_at)} à {time(inv.created_at)}</span>
        </div>

        {mode === 'edit' && form ? (
          <div className="stack" style={{ gap: 14 }}>
            <InvoiceForm value={form} onChange={setForm} clients={clients} />
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setMode('view')}>Annuler</button><button className="btn primary" disabled={busy} onClick={saveEdit}>Enregistrer et recalculer</button></div>
          </div>
        ) : (
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
                {inv.po_number && <><span className="muted">Bon de commande</span><span className="mono">{inv.po_number}</span></>}
                {inv.reference && inv.reference !== inv.po_number && <><span className="muted">Référence</span><span className="mono">{inv.reference}</span></>}
                <span className="muted">Échéance</span><span className="mono">{date(inv.due_date)}{inv.contract ? ` (${inv.contract.payment_terms_days} j)` : ''}</span>
                {inv.period && <><span className="muted">Période</span><span className="mono">{inv.period}</span></>}
              </div>
            </div>
            <table style={{ marginTop: 26 }}>
              <thead><tr><th>Désignation</th><th className="num">Qté</th><th className="num">P.U. {inv.currency}</th><th className="num">Total {inv.currency}</th></tr></thead>
              <tbody>{inv.lines.map(l => (
                <tr key={l.code}>
                  <td>{l.label}{inv.source === 'report' && <div className="tiny muted mono">{l.code}</div>}</td>
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
              {inv.discount_cents > 0 && <div><span>Remise</span><span className="mono">-{money(inv.discount_cents, '').trim()}</span></div>}
              <div><span>{inv.vat_rate_bp ? `TVA ${inv.vat_rate_bp / 100} %` : 'TVA non applicable'}</span><span className="mono">{money(inv.vat_cents, '').trim()}</span></div>
              <div className="grand"><span>Total TTC</span><span className="mono">{money(inv.total_cents, inv.currency)}</span></div>
              {inv.status === 'validated' && inv.amount_paid_cents > 0 && <div><span>Reste à payer</span><span className="mono">{money(inv.balance_due_cents, inv.currency)}</span></div>}
            </div>
            {(org?.bank_details || inv.notes) && <p className="small muted" style={{ marginTop: 22, borderTop: '1px solid #E6E0D3', paddingTop: 10 }}>{org?.bank_details}{inv.notes ? <><br />{inv.notes}</> : null}</p>}
            <div className="nonfiscal"><b>Document non fiscal — projet de facture.</b> La facture normalisée DGI est émise par votre dispositif électronique fiscal homologué.</div>
          </article>

          <aside className="stack">
            <div className="card checks">
              <div className="card-head"><h2 style={{ fontSize: 17 }}>Contrôles</h2>{attention > 0 && <span className="badge alert">{attention} à vérifier</span>}</div>
              {inv.checks.map(c => (
                <div className="check" key={c.id}><span className={`check-icon ${c.status}`}>{ICON[c.status]}</span><div><div className="t">{c.title}</div><div className="n">{c.note}</div></div></div>
              ))}
              {inv.document && <div className="check"><span className="check-icon info"><Icon name="doc" size={13} /></span><div className="n">Source : <button className="btn ghost small" style={{ padding: 0, height: 'auto' }} onClick={() => download(`/api/documents/${inv.document!.id}/file`, inv.document!.filename)}><span className="mono">{inv.document.filename}</span></button>{inv.contract ? ` · contrat ${inv.contract.reference}` : ''}</div></div>}
            </div>
            {inv.corrections.length > 0 && (
              <div className="card card-pad small"><div className="eyebrow">Corrections</div>{inv.corrections.map((c, i) => <div key={i}><span className="mono">{c.code}</span> : {qtyFr(c.before)} → {qtyFr(c.after)}{c.note ? ` — ${c.note}` : ''}</div>)}</div>
            )}

            {inv.status === 'validated' && (<>
              <div className="success stack" style={{ gap: 8 }}>
                <b>Facture validée — {inv.number}</b>
                <span className="small">Par {who}{inv.decided_at ? ` le ${date(inv.decided_at)} à ${time(inv.decided_at)}` : ''}. Copie archivée sur le serveur.</span>
                <button className="btn primary" onClick={() => download(`/api/invoices/${inv.id}/pdf`, `${inv.number}.pdf`)}><Icon name="download" size={16} /> Télécharger le PDF</button>
                {next.length > 0 && <button className="btn" onClick={() => navigate(`/validations/${next[0]}`)}>Validation suivante ({next.length})</button>}
              </div>
              <Payments invoice={inv} canEdit={validator} onChange={setInv} />
              {validator && <ShareAndSend invoice={inv} />}
            </>)}
            {inv.status === 'rejected' && <div className="card card-pad small"><b>Rejetée.</b> {inv.reject_reason}</div>}

            {inv.status === 'draft' && validator && mode === 'view' && (<>
              <button className="btn primary block" style={{ height: 48 }} disabled={busy || blocking} onClick={validate}><Icon name="check" size={16} /> Valider la facture</button>
              <div className="row">
                {inv.source === 'report'
                  ? <button className="btn grow" onClick={() => setMode('correct')}>Corriger</button>
                  : <button className="btn grow" onClick={startEdit}>Modifier</button>}
                <button className="btn danger grow" onClick={() => setMode('reject')}>Rejeter</button>
              </div>
              <button className="btn ghost small" onClick={() => download(`/api/invoices/${inv.id}/pdf`, `${inv.number}.pdf`)}><Icon name="download" size={14} /> Aperçu PDF</button>
              <p className="tiny muted" style={{ textAlign: 'center', margin: 0 }}>{blocking ? 'Un contrôle bloque la validation : corrigez ou rejetez.' : "Rien n'est envoyé sans votre validation."}</p>
            </>)}
            {mode === 'correct' && (
              <div className="card card-pad stack">
                <b>Corriger les quantités</b>
                <span className="small muted">Modifiez les quantités dans la facture. Les montants sont recalculés ; la correction est enregistrée.</span>
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
            {inv.status === 'draft' && !validator && <p className="small muted">Votre rôle permet de consulter cette facture, pas de la valider.</p>}
            <Link className="small" to="/factures">← Toutes les factures</Link>
          </aside>
        </div>
        )}
      </div>
    </Shell>
  )
}

function Payments({ invoice, canEdit, onChange }: { invoice: Invoice; canEdit: boolean; onChange: (i: Invoice) => void }) {
  const { toast } = useSession()
  const [list, setList] = useState<Payment[]>([])
  const [f, setF] = useState({ amount: '', paid_on: new Date().toISOString().slice(0, 10), method: 'mobile_money', note: '' })
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api.get<{ payments: Payment[] }>(`/api/invoices/${invoice.id}/payments`).then(r => setList(r.payments)).catch(() => undefined), [invoice.id])
  useEffect(() => { void load() }, [load, invoice.amount_paid_cents])
  const run = async (fn: () => Promise<{ invoice: Invoice }>, done: string) => {
    setBusy(true)
    try { onChange((await fn()).invoice); toast(done); setF(x => ({ ...x, amount: '', note: '' })) } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }
  return (
    <div className="card card-pad stack small">
      <div className="spread"><b>Paiements reçus</b><span className="mono">{money(invoice.amount_paid_cents, invoice.currency)} / {money(invoice.total_cents, invoice.currency)}</span></div>
      {list.length === 0 && <span className="muted">Aucun paiement enregistré.</span>}
      {list.map(p => (
        <div key={p.id} className="spread">
          <span>{date(p.paid_on)} · {p.reversal_of ? 'Annulation' : METHODS[p.method ?? 'autre'] ?? p.method}{p.note ? ` · ${p.note}` : ''}</span>
          <span className="row" style={{ gap: 6 }}><span className="mono">{money(p.amount_cents, invoice.currency)}</span>
            {canEdit && !p.reversal_of && !p.reversed && <button className="btn small ghost" disabled={busy} title="Annuler ce paiement" onClick={() => { const why = window.prompt('Raison de l\'annulation ?'); if (why && why.trim().length >= 3) void run(() => api.post(`/api/invoices/${invoice.id}/payments/${p.id}/reverse`, { reason: why.trim() }), 'Paiement annulé.') }}><Icon name="x" size={12} /></button>}
          </span>
        </div>
      ))}
      {canEdit && invoice.payment_status !== 'paid' && (
        <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <input className="input mono" placeholder={`Montant (reste ${money(invoice.balance_due_cents, '').trim()})`} inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} />
            <input className="input" type="date" value={f.paid_on} onChange={e => setF({ ...f, paid_on: e.target.value })} aria-label="Date du paiement" />
          </div>
          <div className="row" style={{ gap: 6 }}>
            <select className="input" value={f.method} onChange={e => setF({ ...f, method: e.target.value })} aria-label="Moyen de paiement">{Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input className="input" placeholder="Note (référence…)" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} />
          </div>
          <button className="btn small primary" disabled={busy || !f.amount} onClick={() => run(() => api.post(`/api/invoices/${invoice.id}/payments`, { amount: f.amount.replace(/\s/g, ''), paid_on: f.paid_on, method: f.method, note: f.note || null }, { 'idempotency-key': uuid() }), 'Paiement enregistré.')}>Enregistrer le paiement</button>
        </div>
      )}
    </div>
  )
}

function ShareAndSend({ invoice }: { invoice: Invoice }) {
  const { toast } = useSession()
  const [shares, setShares] = useState<Share[]>([])
  const [link, setLink] = useState<string | null>(null)
  const [to, setTo] = useState(invoice.client.email ?? '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api.get<{ shares: Share[] }>(`/api/invoices/${invoice.id}/shares`).then(r => setShares(r.shares)).catch(() => undefined), [invoice.id])
  useEffect(() => { void load() }, [load])
  const share = async () => {
    setBusy(true)
    try { const r = await api.post<{ share: { url: string } }>(`/api/invoices/${invoice.id}/shares`, { days: 30 }); setLink(r.share.url); await load() }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }
  const send = async () => {
    setBusy(true)
    try { const r = await api.post<{ to: string }>(`/api/invoices/${invoice.id}/send`, { to: to || undefined, message: message || undefined }, { 'idempotency-key': uuid() }); toast(`Facture envoyée à ${r.to}.`) }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }
  return (
    <div className="card card-pad stack small">
      <b>Partager et envoyer</b>
      <button className="btn small" disabled={busy} onClick={share}>Créer un lien de partage (30 jours)</button>
      {link && <div className="stack" style={{ gap: 4 }}><input className="input mono" readOnly value={link} onFocus={e => e.target.select()} aria-label="Lien de partage" /><button className="btn small ghost" onClick={() => { void navigator.clipboard?.writeText(link); toast('Lien copié.') }}>Copier le lien</button><span className="tiny muted">Le lien n'est montré qu'une fois. Toute personne qui l'a peut lire ce PDF jusqu'à son expiration.</span></div>}
      {shares.filter(s => !s.revoked_at).map(s => (
        <div className="spread" key={s.id}><span className="tiny muted">Lien du {date(s.created_at)} · {s.views} consultation{s.views > 1 ? 's' : ''} · expire le {date(s.expires_at)}</span>
          <button className="btn small ghost" onClick={async () => { await api.del(`/api/invoices/${invoice.id}/shares/${s.id}`); toast('Lien désactivé.'); await load() }}>Désactiver</button></div>
      ))}
      <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <input className="input" type="email" placeholder="Adresse du destinataire" value={to} onChange={e => setTo(e.target.value)} aria-label="Destinataire" />
        <textarea className="input" rows={2} placeholder="Message (facultatif)" value={message} onChange={e => setMessage(e.target.value)} />
        <button className="btn small primary" disabled={busy || !to} onClick={send}><Icon name="mail" size={14} /> Envoyer par e-mail avec le PDF</button>
      </div>
    </div>
  )
}
