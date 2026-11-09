/** Prepaid credits: 1 credit = 1 report turned into a draft invoice. Recharges are done by our team after payment. */
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Shell } from '../components/Shell'
import { useSession } from '../state'

interface Entry { id: number; kind: 'topup' | 'consume' | 'adjust'; amount: number; ref: string; filename: string | null; created_at: string }

export function Credits() {
  const { me, config } = useSession()
  const [data, setData] = useState<{ balance: number; entries: Entry[] } | null>(null)
  useEffect(() => { void api.get<{ balance: number; entries: Entry[] }>('/api/credits').then(setData) }, [])
  const subject = encodeURIComponent(`Recharge de crédits — ${me?.org?.name ?? ''}`)

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
            <p style={{ margin: 0 }}>Le paiement en ligne (mobile money et carte) arrive bientôt. En attendant, notre équipe recharge votre compte dès réception de votre paiement.</p>
            {config?.supportEmail
              ? <a className="btn primary" href={`mailto:${config.supportEmail}?subject=${subject}`}>Demander une recharge</a>
              : <p className="small muted" style={{ margin: 0 }}>Contactez votre interlocuteur habituel.</p>}
            {config?.supportEmail && <span className="hint">{config.supportEmail}</span>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2 style={{ fontSize: 17 }}>Historique</h2></div>
          {data && data.entries.length === 0 && <div className="empty">Aucun mouvement.</div>}
          {data && data.entries.length > 0 && (
            <table className="table"><thead><tr><th>Date</th><th>Mouvement</th><th>Détail</th><th className="right">Crédits</th></tr></thead>
              <tbody>{data.entries.map(e => (
                <tr key={e.id}><td className="small muted">{new Date(e.created_at).toLocaleString('fr-FR')}</td>
                  <td>{e.kind === 'topup' ? (e.ref === 'BIENVENUE' ? 'Crédits de bienvenue' : 'Recharge') : e.kind === 'consume' ? 'Rapport traité' : 'Ajustement'}</td>
                  <td className="small mono">{e.kind === 'consume' ? e.filename : e.ref}</td>
                  <td className="right mono" style={{ color: e.amount > 0 ? 'var(--green-ink)' : undefined }}>{e.amount > 0 ? `+${e.amount}` : e.amount}</td></tr>
              ))}</tbody></table>
          )}
        </div>
      </div>
    </Shell>
  )
}
