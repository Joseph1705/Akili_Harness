/** Prepaid credits: 1 credit = 1 report turned into a draft invoice. */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { Shell } from '../components/Shell'
import { can, useSession } from '../state'

interface Entry { id: number; kind: 'topup' | 'consume' | 'adjust'; amount: number; ref: string; filename: string | null; created_at: string }
const PACKS = [{ credits: 100, label: 'Essentiel' }, { credits: 500, label: 'Pro' }, { credits: 2000, label: 'Volume' }]

export function Credits() {
  const { me, toast } = useSession()
  const [data, setData] = useState<{ balance: number; entries: Entry[] } | null>(null)
  const [credits, setCredits] = useState(100)
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => api.get<{ balance: number; entries: Entry[] }>('/api/credits').then(setData)
  useEffect(() => { void load() }, [])

  async function topup() {
    setBusy(true)
    try { await api.post('/api/credits/topup', { credits, ref }); setRef(''); await load(); toast(`${credits} crédits ajoutés.`) }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  return (
    <Shell crumb="Compte" title="Crédits">
      <div className="page stack" style={{ gap: 18 }}>
        <div className="two-col" style={{ marginTop: 0 }}>
          <div className="card stat" style={{ minHeight: 170 }}>
            <span className="dia" /><span className="eyebrow">Solde</span>
            <span className="big" style={{ fontSize: 56 }}>{data?.balance ?? '–'} <small>crédits</small></span>
            <span className="muted">1 crédit = 1 rapport transformé en projet de facture. Les doublons et les échecs ne consomment rien. Quand le solde est à zéro, les rapports attendent la prochaine recharge.</span>
          </div>
          <div className="card panel">
            <div className="eyebrow">Recharger</div>
            {can.configure(me?.org?.role) ? (<>
              <div className="segmented">{PACKS.map(p => <button key={p.credits} type="button" aria-pressed={credits === p.credits} onClick={() => setCredits(p.credits)}>{p.label} · {p.credits}</button>)}</div>
              <div className="field"><label htmlFor="ref">Référence de paiement</label><input id="ref" className="input mono" value={ref} onChange={e => setRef(e.target.value)} placeholder="Ex. M-PESA ou virement" /><span className="hint">Paiement mobile money intégré : bientôt. En démonstration, saisissez une référence fictive.</span></div>
              <button className="btn primary" disabled={busy || ref.trim().length < 3} onClick={topup}>Ajouter {credits} crédits</button>
            </>) : <p className="small muted">Seuls les propriétaires et administrateurs rechargent le compte.</p>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2 style={{ fontSize: 17 }}>Historique</h2></div>
          {data && data.entries.length === 0 && <div className="empty">Aucun mouvement.</div>}
          {data && data.entries.length > 0 && (
            <table className="table"><thead><tr><th>Date</th><th>Mouvement</th><th>Détail</th><th className="right">Crédits</th></tr></thead>
              <tbody>{data.entries.map(e => (
                <tr key={e.id}><td className="small muted">{new Date(e.created_at).toLocaleString('fr-FR')}</td>
                  <td>{e.kind === 'topup' ? 'Recharge' : e.kind === 'consume' ? 'Rapport traité' : 'Ajustement'}</td>
                  <td className="small mono">{e.kind === 'consume' ? e.filename : e.ref}</td>
                  <td className="right mono" style={{ color: e.amount > 0 ? 'var(--green-ink)' : undefined }}>{e.amount > 0 ? `+${e.amount}` : e.amount}</td></tr>
              ))}</tbody></table>
          )}
        </div>
      </div>
    </Shell>
  )
}
