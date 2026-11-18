/**
 * Prepaid document credits (DIRECTIVES §5 G–H): balance and totals, usage per day / week / month, low-balance
 * alert, packages to buy through SasPay, purchase history, and the full credit history.
 * Credits are added only after our server has verified the payment with SasPay — never because this page
 * was opened from the payment page.
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiError, date, money, uuid } from '../api'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, useSession } from '../state'

interface Wallet { balance: number; total_purchased: number; total_consumed: number; total_refunded: number; total_allocated: number; low_balance_threshold: number; low: boolean }
interface Entry { id: string; type: string; amount: number; balance_before: number; balance_after: number; payment_reference: string | null; reason: string | null; filename: string | null; invoice_number: string | null; created_at: string; seq: number }
interface Pack { id: string; name: string; credits: number; price_cents: number; currency: string; description: string | null; promotional: boolean }
interface Purchase { id: string; package_name: string; credits: number; amount_cents: number; currency: string; status: string; checkout_url: string | null; failure_reason: string | null; created_at: string; credited_at: string | null }
interface Usage { buckets: Array<{ bucket: string; consumed: number; added: number }>; averagePerBucket: number }

const TYPE: Record<string, string> = { purchase: 'Achat', consumption: 'Facture générée', refund: 'Remboursement', admin_allocation: 'Allocation', admin_correction: 'Correction' }
const PSTATUS: Record<string, [string, string]> = {
  created: ['Créé', 'neutral'], pending: ['En attente de paiement', 'alert'], succeeded: ['Payé — crédits ajoutés', 'green'],
  failed: ['Échec', 'reject'], cancelled: ['Annulé', 'neutral'], expired: ['Expiré', 'neutral'],
}

export function Credits() {
  const { me, config, toast, refresh } = useSession()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<{ wallet: Wallet; entries: Entry[] } | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day')
  const [packs, setPacks] = useState<Pack[]>([])
  const [online, setOnline] = useState<{ online: boolean; methods: string[] } | null>(null)
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [type, setType] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const billing = can.configure(me?.org?.role)

  const load = useCallback(async () => {
    const r = await api.get<{ wallet: Wallet; entries: Entry[] }>(`/api/credits${type ? `?type=${type}` : ''}`)
    setData(r)
    if (billing) api.get<{ purchases: Purchase[] }>('/api/billing/purchases').then(p => setPurchases(p.purchases)).catch(() => undefined)
  }, [type, billing])
  useEffect(() => { void load() }, [load])
  useEffect(() => { api.get<Usage>(`/api/credits/usage?period=${period}`).then(setUsage).catch(() => undefined) }, [period, data?.wallet.balance])
  useEffect(() => {
    api.get<{ packages: Pack[] }>('/api/billing/packages').then(r => setPacks(r.packages)).catch(() => undefined)
    api.get<{ online: boolean; methods: string[] }>('/api/billing/status').then(setOnline).catch(() => undefined)
  }, [])

  // Back from the SasPay page: ask our server to verify with SasPay (this page proves nothing by itself).
  const returned = params.get('paiement')
  useEffect(() => {
    if (!returned || !billing) return
    api.post<{ purchase: Purchase }>(`/api/billing/purchases/${returned}/verify`).then(r => {
      if (r.purchase.status === 'succeeded') toast(`Paiement confirmé : ${r.purchase.credits} crédits ajoutés.`)
      else if (r.purchase.status === 'pending') toast("Paiement pas encore confirmé par SasPay. Les crédits seront ajoutés dès sa confirmation (cette page se met à jour).")
      else toast(r.purchase.failure_reason ?? 'Le paiement n\'a pas abouti.', 'err')
      setParams({}, { replace: true })
      void load(); void refresh()
    }).catch(err => toast(err instanceof ApiError ? err.message : 'Vérification impossible.', 'err'))
  }, [returned]) // eslint-disable-line react-hooks/exhaustive-deps
  // Pending purchases are re-checked while the page is open.
  useEffect(() => {
    if (!purchases.some(p => p.status === 'pending')) return
    const t = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(t)
  }, [purchases, load])

  async function buy(pack: Pack) {
    setBusy(pack.id)
    try {
      const r = await api.post<{ purchase: Purchase }>('/api/billing/purchases', { packageId: pack.id }, { 'idempotency-key': uuid() })
      if (r.purchase.checkout_url) window.location.assign(r.purchase.checkout_url)
      else toast(r.purchase.failure_reason ?? 'Paiement indisponible.', 'err')
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(null) }
  }

  const w = data?.wallet
  const max = Math.max(1, ...(usage?.buckets.map(b => b.consumed) ?? [1]))
  const subject = encodeURIComponent(`Recharge de crédits — ${me?.org?.name ?? ''}`)
  return (
    <Shell crumb="Compte" title="Crédits">
      <div className="page stack" style={{ gap: 18 }}>
        {w?.low && (
          <div className="callout" role="status"><Icon name="alert" size={16} /><span><b>Solde bas : {w.balance} crédit{w.balance > 1 ? 's' : ''}.</b> {w.balance === 0 ? 'Les nouveaux documents attendront un achat pour être traités.' : 'Pensez à recharger pour ne pas interrompre le traitement des documents.'}</span></div>
        )}
        <div className="stat-grid">
          <div className="card stat"><span className="dia" /><span className="eyebrow">Solde disponible</span><span className="big" style={{ fontSize: 48 }}>{w?.balance ?? '–'}</span><span className="small muted">1 crédit = 1 facture générée à partir d'un document. Échecs, doublons et factures saisies à la main : gratuits.</span></div>
          <div className="card stat"><span className="eyebrow">Achetés</span><span className="big">{w?.total_purchased ?? '–'}</span><span className="small muted">Alloués par notre équipe : {w?.total_allocated ?? 0}</span></div>
          <div className="card stat"><span className="eyebrow">Utilisés</span><span className="big">{w?.total_consumed ?? '–'}</span><span className="small muted">Remboursés : {w?.total_refunded ?? 0}</span></div>
          <div className="card stat"><span className="eyebrow">Rythme récent</span><span className="big">{usage ? usage.averagePerBucket.toFixed(1) : '–'}</span><span className="small muted">documents par {period === 'day' ? 'jour' : period === 'week' ? 'semaine' : 'mois'}{usage && w && usage.averagePerBucket > 0 ? ` · ≈ ${Math.floor(w.balance / usage.averagePerBucket)} ${period === 'day' ? 'jours' : period === 'week' ? 'semaines' : 'mois'} restants` : ''}</span></div>
        </div>

        <div className="card card-pad stack">
          <div className="spread"><b>Utilisation</b>
            <div className="segmented">{([['day', 'Jour'], ['week', 'Semaine'], ['month', 'Mois']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}</div>
          </div>
          <div className="bars" aria-label="Crédits utilisés par période">
            {usage?.buckets.map(b => <span key={b.bucket} data-label={`${date(b.bucket)} : ${b.consumed}`} style={{ height: `${(b.consumed / max) * 100}%` }} />)}
          </div>
          <span className="tiny muted">Crédits utilisés par {period === 'day' ? 'jour (30 derniers jours)' : period === 'week' ? 'semaine (12 dernières)' : 'mois (12 derniers)'}.</span>
        </div>

        <div className="card card-pad stack">
          <div className="spread"><b>Acheter des crédits</b>{online?.online && <span className="small muted">Paiement SasPay : {online.methods.join(', ')}</span>}</div>
          {!billing && <p className="small muted" style={{ margin: 0 }}>Seuls les propriétaires et administrateurs achètent des crédits.</p>}
          {billing && online && !online.online && (
            <p className="small" style={{ margin: 0 }}>Le paiement en ligne n'est pas encore activé sur ce serveur. Notre équipe recharge votre compte dès réception de votre paiement{config?.supportEmail ? <> : <a href={`mailto:${config.supportEmail}?subject=${subject}`}>{config.supportEmail}</a></> : '.'}</p>
          )}
          {billing && online?.online && packs.length === 0 && <p className="small muted" style={{ margin: 0 }}>Aucun paquet n'est proposé pour le moment.</p>}
          {billing && online?.online && packs.length > 0 && (
            <div className="pack-grid">{packs.map(p => (
              <div key={p.id} className="pack" style={{ cursor: 'default' }}>
                {p.promotional && <span className="tag badge solid">Promotion</span>}
                <h3>{p.name}</h3><span className="d">{p.description ?? `${p.credits} documents transformés en factures`}</span>
                <span className="meta">{p.credits.toLocaleString('fr-FR')} crédits · {money(p.price_cents, p.currency)}</span>
                <button className="btn primary small" style={{ marginTop: 8 }} disabled={busy !== null} onClick={() => buy(p)}>{busy === p.id ? <span className="spinner" /> : 'Payer avec SasPay'}</button>
              </div>
            ))}</div>
          )}
        </div>

        {billing && purchases.length > 0 && (
          <div className="card">
            <div className="card-head"><h2 style={{ fontSize: 17 }}>Achats</h2></div>
            <table className="table"><thead><tr><th>Date</th><th>Paquet</th><th>Statut</th><th className="right">Montant</th><th /></tr></thead>
              <tbody>{purchases.map(p => {
                const [label, tone] = PSTATUS[p.status] ?? [p.status, 'neutral']
                return (
                  <tr key={p.id}>
                    <td className="small muted">{new Date(p.created_at).toLocaleString('fr-FR')}</td>
                    <td>{p.package_name} · {p.credits} crédits{p.failure_reason && <div className="tiny muted">{p.failure_reason}</div>}</td>
                    <td><span className={`badge ${tone}`}>{label}</span></td>
                    <td className="right mono">{money(p.amount_cents, p.currency)}</td>
                    <td className="right">{p.status === 'pending' && p.checkout_url && <a className="btn small" href={p.checkout_url}>Reprendre le paiement</a>}</td>
                  </tr>
                )
              })}</tbody></table>
          </div>
        )}

        <div className="card">
          <div className="card-head"><h2 style={{ fontSize: 17 }}>Historique des crédits</h2>
            <select className="input" style={{ width: 'auto' }} value={type} onChange={e => setType(e.target.value)} aria-label="Type de mouvement"><option value="">Tous les mouvements</option>{Object.entries(TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </div>
          {data && data.entries.length === 0 && <div className="empty">Aucun mouvement.</div>}
          {data && data.entries.length > 0 && (
            <table className="table"><thead><tr><th>Date</th><th>Mouvement</th><th>Détail</th><th className="right">Crédits</th><th className="right">Solde</th></tr></thead>
              <tbody>{data.entries.map(e => (
                <tr key={e.id}><td className="small muted">{new Date(e.created_at).toLocaleString('fr-FR')}</td>
                  <td>{TYPE[e.type] ?? e.type}</td>
                  <td className="small">{e.type === 'consumption' ? <>{e.invoice_number && <span className="mono">{e.invoice_number}</span>}{e.filename ? ` · ${e.filename}` : ''}</> : e.reason ?? e.payment_reference ?? ''}{e.payment_reference && e.type === 'purchase' && <div className="tiny muted mono">{e.payment_reference}</div>}</td>
                  <td className="right mono" style={{ color: e.amount > 0 ? 'var(--green-ink)' : undefined }}>{e.amount > 0 ? `+${e.amount}` : e.amount}</td>
                  <td className="right mono small muted">{e.balance_before} → {e.balance_after}</td></tr>
              ))}</tbody></table>
          )}
        </div>
      </div>
    </Shell>
  )
}
