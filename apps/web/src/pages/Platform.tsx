/** Platform administration (our team only): organizations and credit top-ups after payment. */
import { useEffect, useState } from 'react'
import { ago, api, ApiError } from '../api'
import { Shell } from '../components/Shell'
import { useSession } from '../state'

interface Org { id: string; name: string; kind: string; plan: string; city: string | null; created_at: string; onboarding_done_at: string | null; balance: number; members: number; documents: number; owner_email: string | null }

export function Platform() {
  const { toast } = useSession()
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [target, setTarget] = useState<Org | null>(null)
  const [credits, setCredits] = useState('100')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const load = () => api.get<{ orgs: Org[] }>('/api/platform/orgs').then(r => setOrgs(r.orgs))
  useEffect(() => { void load() }, [])

  async function credit() {
    if (!target) return
    setBusy(true)
    try {
      await api.post(`/api/platform/orgs/${target.id}/credits`, { credits: Number(credits), ref })
      toast(`${credits} crédits ajoutés à ${target.name}.`)
      setTarget(null); setRef(''); await load()
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  const shown = (orgs ?? []).filter(o => `${o.name} ${o.owner_email ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Shell crumb="Plateforme" title="Administration">
      <div className="page stack" style={{ gap: 18 }}>
        <div className="spread"><input className="input" style={{ maxWidth: 360 }} placeholder="Rechercher une entreprise ou un e-mail" value={filter} onChange={e => setFilter(e.target.value)} /><span className="small muted">{orgs?.length ?? 0} organisations</span></div>
        {target && (
          <div className="card panel" style={{ maxWidth: 560 }}>
            <b>Créditer {target.name}</b>
            <div className="form-grid">
              <div className="field"><label>Crédits</label><input className="input mono" inputMode="numeric" value={credits} onChange={e => setCredits(e.target.value.replace(/\D/g, ''))} /></div>
              <div className="field"><label>Référence du paiement reçu</label><input className="input mono" value={ref} onChange={e => setRef(e.target.value)} placeholder="M-PESA, virement…" /></div>
            </div>
            <div className="row"><button className="btn primary" disabled={busy || !Number(credits) || ref.trim().length < 3} onClick={credit}>Créditer</button><button className="btn" onClick={() => setTarget(null)}>Annuler</button></div>
          </div>
        )}
        <div className="card">
          <table className="table">
            <thead><tr><th>Organisation</th><th>Propriétaire</th><th>Offre</th><th className="right">Documents</th><th className="right">Solde</th><th /></tr></thead>
            <tbody>{shown.map(o => (
              <tr key={o.id}>
                <td><b>{o.name}</b><div className="tiny muted">{o.city ?? '—'} · inscrite {ago(o.created_at)}{o.onboarding_done_at ? '' : ' · inscription inachevée'}</div></td>
                <td className="small">{o.owner_email}</td>
                <td className="small">{o.plan === 'solo' ? 'Entrepreneur' : 'Entreprise'}</td>
                <td className="right mono">{o.documents}</td>
                <td className="right mono">{o.balance}</td>
                <td className="right"><button className="btn small" onClick={() => { setTarget(o); setRef('') }}>Créditer</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </Shell>
  )
}
