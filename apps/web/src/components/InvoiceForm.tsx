/**
 * Invoice editor: client (existing or new), references, dates, currency, lines, VAT, discount, notes.
 * Totals shown here are a preview only; the server recomputes everything (rule 6).
 */
import { useMemo } from 'react'
import { money } from '../api'
import { Icon } from '../icons'

export interface LineInput { description: string; quantity: string; unit?: string | null; unit_price: string }
export interface NewClient { name: string; address?: string | null; nif?: string | null; rccm?: string | null; email?: string | null; vat_applicable: boolean }
export interface InvoiceInput {
  client: { id: string } | NewClient
  reference?: string | null
  po_number?: string | null
  period?: string | null
  issue_date: string
  due_date: string
  currency: 'USD' | 'CDF'
  lines: LineInput[]
  vat_rate_bp: number
  discount?: { type: 'amount' | 'percent'; value: string } | null
  notes?: string | null
}
export interface ClientOption { id: string; name: string; nif: string | null; vat_applicable: boolean }
export interface Check { id: string; status: 'ok' | 'warning' | 'error' | 'info'; title: string; note: string }

const today = () => new Date().toISOString().slice(0, 10)
export const emptyInvoice = (currency: 'USD' | 'CDF' = 'USD'): InvoiceInput => ({
  client: { name: '', vat_applicable: true }, issue_date: today(), due_date: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
  currency, lines: [{ description: '', quantity: '1', unit: '', unit_price: '' }], vat_rate_bp: 1600, discount: null, notes: null, reference: null, po_number: null,
})

const cents = (v: string) => {
  const s = v.trim().replace(/\s/g, '').replace(',', '.')
  return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN
}
const qty = (v: string) => {
  const s = v.trim().replace(',', '.')
  return /^\d+(\.\d{1,3})?$/.test(s) ? Number(s) : NaN
}

export function previewTotals(v: InvoiceInput) {
  const lines = v.lines.map(l => Math.round(qty(l.quantity) * cents(l.unit_price)))
  const subtotal = lines.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  let discount = 0
  if (v.discount?.value) discount = v.discount.type === 'amount' ? cents(v.discount.value) : Math.round(subtotal * Number(v.discount.value.replace(',', '.')) / 100)
  if (!Number.isFinite(discount)) discount = 0
  const base = Math.max(0, subtotal - discount)
  const vat = Math.round(base * v.vat_rate_bp / 10_000)
  return { lines, subtotal, discount, vat, total: base + vat, valid: lines.every(Number.isFinite) }
}

export function InvoiceForm({ value, onChange, clients, checks, disabled }: {
  value: InvoiceInput; onChange: (v: InvoiceInput) => void; clients: ClientOption[]; checks?: Check[]; disabled?: boolean
}) {
  const set = (patch: Partial<InvoiceInput>) => onChange({ ...value, ...patch })
  const setLine = (i: number, patch: Partial<LineInput>) => set({ lines: value.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  const existing = 'id' in value.client ? value.client.id : ''
  const nc = 'id' in value.client ? null : value.client
  const totals = useMemo(() => previewTotals(value), [value])
  const rateChoice = value.vat_rate_bp === 1600 ? '1600' : value.vat_rate_bp === 0 ? '0' : 'other'

  return (
    <div className="stack" style={{ gap: 16 }}>
      <fieldset className="card card-pad stack" disabled={disabled} style={{ border: 0 }}>
        <b>Client</b>
        <div className="form-grid">
          <div className="field full">
            <label htmlFor="inv-client">Client facturé</label>
            <select id="inv-client" className="input" value={existing || 'new'} onChange={e => {
              if (e.target.value === 'new') set({ client: { name: nc?.name ?? '', vat_applicable: true } })
              else { const c = clients.find(x => x.id === e.target.value)!; set({ client: { id: c.id }, vat_rate_bp: c.vat_applicable ? value.vat_rate_bp || 1600 : 0 }) }
            }}>
              <option value="new">Nouveau client…</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.nif ? ` · NIF ${c.nif}` : ''}</option>)}
            </select>
          </div>
          {nc && <>
            <div className="field full"><label>Raison sociale du nouveau client</label><input className="input" value={nc.name} onChange={e => set({ client: { ...nc, name: e.target.value } })} /></div>
            <div className="field"><label>NIF</label><input className="input mono" value={nc.nif ?? ''} onChange={e => set({ client: { ...nc, nif: e.target.value || null } })} /></div>
            <div className="field"><label>RCCM</label><input className="input mono" value={nc.rccm ?? ''} onChange={e => set({ client: { ...nc, rccm: e.target.value || null } })} /></div>
            <div className="field"><label>E-mail de facturation</label><input className="input" type="email" value={nc.email ?? ''} onChange={e => set({ client: { ...nc, email: e.target.value || null } })} /></div>
            <div className="field"><label>TVA</label><select className="input" value={nc.vat_applicable ? 'yes' : 'no'} onChange={e => set({ client: { ...nc, vat_applicable: e.target.value === 'yes' } })}><option value="yes">Applicable</option><option value="no">Non applicable (exonéré)</option></select></div>
            <div className="field full"><label>Adresse</label><input className="input" value={nc.address ?? ''} onChange={e => set({ client: { ...nc, address: e.target.value || null } })} /></div>
          </>}
        </div>
      </fieldset>

      <fieldset className="card card-pad stack" disabled={disabled} style={{ border: 0 }}>
        <b>Facture</b>
        <div className="form-grid">
          <div className="field"><label>Numéro</label><input className="input mono" value="Attribué automatiquement" disabled /><span className="hint">Brouillon P-…, puis FAC-… à la validation, sans trou.</span></div>
          <div className="field"><label>Référence du document</label><input className="input mono" value={value.reference ?? ''} onChange={e => set({ reference: e.target.value || null })} placeholder="BL-2026-118, devis…" /></div>
          <div className="field"><label>Bon de commande du client</label><input className="input mono" value={value.po_number ?? ''} onChange={e => set({ po_number: e.target.value || null })} /></div>
          <div className="field"><label>Période</label><input className="input" value={value.period ?? ''} onChange={e => set({ period: e.target.value || null })} placeholder="Octobre 2026" /></div>
          <div className="field"><label>Date de facture</label><input className="input" type="date" value={value.issue_date} onChange={e => set({ issue_date: e.target.value })} /></div>
          <div className="field"><label>Échéance</label><input className="input" type="date" value={value.due_date} onChange={e => set({ due_date: e.target.value })} /></div>
          <div className="field"><label>Devise</label><select className="input" value={value.currency} onChange={e => set({ currency: e.target.value as 'USD' | 'CDF' })}><option>USD</option><option>CDF</option></select></div>
        </div>
      </fieldset>

      <fieldset className="card card-pad stack" disabled={disabled} style={{ border: 0 }}>
        <b>Lignes</b>
        <div className="invoice-lines">
          <div className="invoice-line head"><span>Désignation</span><span>Qté</span><span>Unité</span><span>P.U.</span><span className="right">Montant</span><span /></div>
          {value.lines.map((l, i) => (
            <div className="invoice-line" key={i}>
              <input className="input" aria-label={`Désignation ligne ${i + 1}`} value={l.description} onChange={e => setLine(i, { description: e.target.value })} />
              <input className="input mono" aria-label={`Quantité ligne ${i + 1}`} inputMode="decimal" value={l.quantity} onChange={e => setLine(i, { quantity: e.target.value })} />
              <input className="input" aria-label={`Unité ligne ${i + 1}`} value={l.unit ?? ''} onChange={e => setLine(i, { unit: e.target.value })} placeholder="jour" />
              <input className="input mono" aria-label={`Prix unitaire ligne ${i + 1}`} inputMode="decimal" value={l.unit_price} onChange={e => setLine(i, { unit_price: e.target.value })} placeholder="0,00" />
              <span className="right mono small">{Number.isFinite(totals.lines[i]) ? money(totals.lines[i]!, '').trim() : '—'}</span>
              <button type="button" className="btn small ghost" aria-label={`Retirer la ligne ${i + 1}`} disabled={value.lines.length === 1} onClick={() => set({ lines: value.lines.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
            </div>
          ))}
        </div>
        <div><button type="button" className="btn small" onClick={() => set({ lines: [...value.lines, { description: '', quantity: '1', unit: '', unit_price: '' }] })}><Icon name="plus" size={14} /> Ligne</button></div>
        <div className="form-grid">
          <div className="field"><label>TVA</label>
            <select className="input" value={rateChoice} onChange={e => set({ vat_rate_bp: e.target.value === 'other' ? 800 : Number(e.target.value) })}>
              <option value="1600">16 % (taux standard)</option><option value="0">Non applicable</option><option value="other">Autre taux…</option>
            </select>
            {rateChoice === 'other' && <input className="input mono" style={{ marginTop: 6 }} aria-label="Taux de TVA en %" inputMode="decimal" value={String(value.vat_rate_bp / 100)} onChange={e => { const n = Number(e.target.value.replace(',', '.')); if (Number.isFinite(n) && n >= 0 && n <= 100) set({ vat_rate_bp: Math.round(n * 100) }) }} />}
          </div>
          <div className="field"><label>Remise</label>
            <div className="row" style={{ gap: 6 }}>
              <select className="input" style={{ maxWidth: 130 }} value={value.discount?.type ?? 'none'} onChange={e => set({ discount: e.target.value === 'none' ? null : { type: e.target.value as 'amount' | 'percent', value: value.discount?.value ?? '' } })}>
                <option value="none">Aucune</option><option value="percent">En %</option><option value="amount">Montant</option>
              </select>
              {value.discount && <input className="input mono" aria-label="Valeur de la remise" inputMode="decimal" value={value.discount.value} onChange={e => set({ discount: { ...value.discount!, value: e.target.value } })} />}
            </div>
          </div>
          <div className="field full"><label>Notes (bas de facture)</label><textarea className="input" rows={2} value={value.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></div>
        </div>
        <div className="totals" style={{ alignSelf: 'flex-end', minWidth: 280 }}>
          <div><span>Total HT</span><span className="mono">{money(totals.subtotal, '').trim()}</span></div>
          {totals.discount > 0 && <div><span>Remise</span><span className="mono">-{money(totals.discount, '').trim()}</span></div>}
          <div><span>{value.vat_rate_bp ? `TVA ${value.vat_rate_bp / 100} %` : 'TVA non applicable'}</span><span className="mono">{money(totals.vat, '').trim()}</span></div>
          <div className="grand"><span>Total TTC (aperçu)</span><span className="mono">{money(totals.total, value.currency)}</span></div>
        </div>
      </fieldset>

      {checks && checks.length > 0 && (
        <div className="card checks">
          <div className="card-head"><b>Contrôles</b></div>
          {checks.map(c => (
            <div className="check" key={c.id}><span className={`check-icon ${c.status}`}>{({ ok: '✓', warning: '!', error: '×', info: 'i' } as const)[c.status]}</span><div><div className="t">{c.title}</div><div className="n">{c.note}</div></div></div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Clean the form before sending: amounts with a dot, empty optional fields as null. */
export function toPayload(v: InvoiceInput): InvoiceInput {
  const nn = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null)
  return {
    ...v,
    client: 'id' in v.client ? { id: v.client.id } : { ...v.client, name: v.client.name.trim(), address: nn(v.client.address), nif: nn(v.client.nif), rccm: nn(v.client.rccm), email: nn(v.client.email) },
    reference: nn(v.reference), po_number: nn(v.po_number), period: nn(v.period), notes: nn(v.notes),
    lines: v.lines.filter(l => l.description.trim() || l.unit_price.trim()).map(l => ({
      description: l.description.trim(), quantity: l.quantity.trim().replace(',', '.'), unit: nn(l.unit), unit_price: l.unit_price.trim().replace(/\s/g, '').replace(',', '.'),
    })),
    discount: v.discount && v.discount.value.trim() ? { type: v.discount.type, value: v.discount.value.trim().replace(',', '.') } : null,
  }
}
