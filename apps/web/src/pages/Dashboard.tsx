/** Design screen E — Activité du jour. */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, api, money } from '../api'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, useSession } from '../state'

interface Dash {
  agents: { active: number; total: number; paused: string[]; list: Array<{ id: string; name: string; status: string; last_action_at: string | null; docs_today: number }> }
  documentsToday: { done: number; duplicate: number; failed: number; waiting: number }
  pending: { count: number; oldest_at: string | null; items: Array<{ id: string; number: string; total_cents: number; currency: string; created_at: string; client_name: string; agent_name: string; attention: number }> }
  credits: number
}

export function Dashboard() {
  const { me } = useSession()
  const [d, setD] = useState<Dash | null>(null)
  useEffect(() => {
    const load = () => api.get<Dash>('/api/dashboard').then(setD).catch(() => undefined)
    void load()
    const t = window.setInterval(load, 6000)
    return () => window.clearInterval(t)
  }, [])
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  const totalDocs = d ? d.documentsToday.done + d.documentsToday.duplicate + d.documentsToday.failed + d.documentsToday.waiting : 0
  const pct = (n: number) => (totalDocs ? `${(n / totalDocs) * 100}%` : '0')

  return (
    <Shell crumb="Espace de travail" title="Activité du jour">
      <div className="page stack" style={{ gap: 18 }}>
        <div className="spread">
          <div>
            <h1 style={{ fontSize: 30 }}>Bonjour {me?.user.first_name ?? ''}.</h1>
            <div className="muted" style={{ marginTop: 4 }}>{today.charAt(0).toUpperCase() + today.slice(1)} · {d ? `${d.agents.active} agent${d.agents.active > 1 ? 's' : ''} actif${d.agents.active > 1 ? 's' : ''}` : '…'}</div>
          </div>
          {can.configure(me?.org?.role) && <Link className="btn" to="/packs"><Icon name="plus" size={16} /> Nouvel agent</Link>}
        </div>

        <div className="stat-grid">
          <div className="card stat"><span className="dia" /><span className="eyebrow">Agents actifs</span>
            <span className="big">{d?.agents.active ?? '–'} <small>sur {d?.agents.total ?? '–'}</small></span>
            <span className="small muted">{d?.agents.paused.length ? `« ${d.agents.paused[0]} » est en pause.` : 'Tous vos agents travaillent.'}</span>
          </div>
          <div className="card stat"><span className="dia" /><span className="eyebrow">Documents reçus aujourd'hui</span>
            <span className="big">{totalDocs}</span>
            <div className="bar">
              <span style={{ width: pct(d?.documentsToday.done ?? 0), background: 'var(--green)' }} />
              <span style={{ width: pct(d?.documentsToday.waiting ?? 0), background: 'var(--green-soft)' }} />
              <span style={{ width: pct(d?.documentsToday.duplicate ?? 0), background: 'var(--muted)' }} />
              <span style={{ width: pct(d?.documentsToday.failed ?? 0), background: 'var(--copper)' }} />
            </div>
            <span className="small muted">Traités {d?.documentsToday.done ?? 0} · En cours {d?.documentsToday.waiting ?? 0} · Doublons {d?.documentsToday.duplicate ?? 0} · Échecs {d?.documentsToday.failed ?? 0}</span>
          </div>
          <div className="card stat feature"><span className="eyebrow">Validations en attente</span>
            <span className="big" style={{ color: '#fff' }}>{d?.pending.count ?? '–'}</span>
            <Link to={d?.pending.items[0] ? `/validations/${d.pending.items[0].id}` : '/validations'}>Examiner maintenant <Icon name="arrow" size={14} /></Link>
          </div>
          <div className="card stat"><span className="dia" /><span className="eyebrow">Crédits restants</span>
            <span className="big">{d?.credits ?? '–'}</span>
            <span className="small muted">1 crédit = 1 rapport transformé en facture. <Link to="/credits">Recharger</Link></span>
          </div>
        </div>

        <div className="two-col">
          <div className="card">
            <div className="card-head"><h2 style={{ fontSize: 17 }}>À valider avant envoi</h2><span className="small muted">{d?.pending.oldest_at ? `Le plus ancien : ${ago(d.pending.oldest_at)}` : ''}</span></div>
            {d && d.pending.items.length === 0 && <div className="empty">Rien à valider. Déposez des rapports dans une <Link to="/sessions/nouvelle">nouvelle session</Link>.</div>}
            {d?.pending.items.map(i => (
              <div className="list-row" key={i.id}>
                <div className="grow">
                  <div><span className="type-tag">FACTURE</span> <span className="mono tiny muted">{i.number}</span> {i.attention > 0 && <span className="badge alert">{i.attention} à vérifier</span>}</div>
                  <div style={{ fontWeight: 600 }}>{i.client_name}</div>
                  <div className="tiny muted">Préparé par {i.agent_name} · {ago(i.created_at)}</div>
                </div>
                <span className="mono" style={{ fontWeight: 500 }}>{money(i.total_cents, i.currency)}</span>
                <Link className="btn small" to={`/validations/${i.id}`}>Ouvrir</Link>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="card-head"><h2 style={{ fontSize: 17 }}>Vos agents</h2><span className="small muted">Docs du jour</span></div>
            {d && d.agents.list.length === 0 && <div className="empty">Aucun agent. <Link to="/packs">Créer un agent</Link></div>}
            {d?.agents.list.map(a => (
              <div className="list-row" key={a.id}>
                <span className={`agent-dot${a.status === 'active' ? '' : ' off'}`} />
                <div className="grow"><div style={{ fontWeight: 600 }}>{a.name}</div><div className="tiny muted">{a.status === 'active' ? 'Actif' : 'En pause'}{a.last_action_at ? ` · dernière action ${ago(a.last_action_at)}` : ''}</div></div>
                <span className="mono">{a.docs_today}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  )
}
