/** Sidebar + top bar, as in design screens A–F. */
import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ago, api } from '../api'
import { Icon } from '../icons'
import { can, displayName, initials, ROLE_LABEL, useSession } from '../state'
import { BrandMark, BrandName } from './Brand'

interface SessionItem { id: string; title: string; updated_at: string; waiting: number; agent_name: string | null }

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('theme') ?? 'auto' } catch { return 'auto' } })
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try { localStorage.setItem('theme', theme) } catch { /* private mode: theme not remembered */ }
  }, [theme])
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return [dark ? 'sombre' : 'clair', () => setTheme(dark ? 'light' : 'dark')]
}

export function hostingBadge(label: string | undefined): string {
  if (!label) return ''
  return label.startsWith('Serveur local') ? 'Données stockées localement' : label
}

export function Shell({ crumb, title, actions, children }: { crumb: string; title: string; actions?: ReactNode; children: ReactNode }) {
  const { me, config } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [pending, setPending] = useState(0)
  const [themeLabel, toggleTheme] = useTheme()

  useEffect(() => {
    let alive = true
    const load = () => {
      api.get<{ sessions: SessionItem[] }>('/api/sessions').then(r => alive && setSessions(r.sessions)).catch(() => undefined)
      api.get<{ invoices: unknown[] }>('/api/invoices?status=draft').then(r => alive && setPending(r.invoices.length)).catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 8000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [location.pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && can.operate(me?.org?.role)) { e.preventDefault(); navigate('/sessions/nouvelle') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, me])

  const label = hostingBadge(me?.app.hostingLabel ?? config?.hostingLabel)
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Navigation">
        <Link className="brand" to="/"><BrandMark /><span><BrandName /></span></Link>
        {can.operate(me?.org?.role) && (
          <Link className="btn new-session" to="/sessions/nouvelle"><span className="row" style={{ gap: 8 }}><Icon name="plus" size={16} /> Nouvelle session</span><kbd>Ctrl N</kbd></Link>
        )}
        <div>
          <div className="eyebrow" style={{ padding: '0 8px 6px' }}>Sessions</div>
          <div className="side-list">
            {sessions.length === 0 && <div className="muted tiny" style={{ padding: '4px 8px' }}>Aucune session pour l'instant.</div>}
            {sessions.slice(0, 7).map(s => (
              <NavLink key={s.id} to={`/sessions/${s.id}`} className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}>
                <span className="t">{s.title}</span>
                <span className="m">{s.waiting > 0 ? `en attente de vous · ${s.waiting}` : 'terminé'} · {ago(s.updated_at)}</span>
              </NavLink>
            ))}
          </div>
        </div>
        <nav className="nav">
          <NavLink to="/validations"><Icon name="check" /> Validations <span className={`count${pending ? ' on' : ''}`}>{pending}</span></NavLink>
          <NavLink to="/packs"><Icon name="diamond" /> Packs d'agents</NavLink>
          <NavLink to="/" end><Icon name="activity" /> Activité</NavLink>
          <NavLink to="/credits"><Icon name="coin" /> Crédits</NavLink>
          <NavLink to="/parametres"><Icon name="gear" /> Paramètres</NavLink>
          <NavLink to="/a-propos"><Icon name="diamond" /> À propos</NavLink>
        </nav>
        <div className="host-box">
          <b>◆ {me?.app.hostingLabel}</b>
          {me?.app.models.deepseek || me?.app.models.anthropic
            ? 'Vos fichiers restent sur ce serveur. Un modèle externe n\'est appelé qu\'avec votre consentement.'
            : 'Vos fichiers restent sur ce serveur. Aucun modèle externe n\'est appelé.'}
          <div style={{ marginTop: 8 }}><button className="theme-btn" onClick={toggleTheme}><Icon name="moon" size={14} /> Mode {themeLabel === 'clair' ? 'sombre' : 'clair'}</button></div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="grow">
            <div className="eyebrow">{crumb}</div>
            <h1>{title}</h1>
          </div>
          {actions}
          {label && <span className="pill-local"><Icon name="diamond" size={14} /> {label}</span>}
          <Link to="/parametres" className="user-chip" title="Paramètres">
            <span className="avatar">{initials(me)}</span>
            <span><span className="n" style={{ display: 'block' }}>{displayName(me)}</span><span className="r">{me?.org ? ROLE_LABEL[me.org.role] : ''} · {me?.org?.name}</span></span>
          </Link>
        </header>
        <main className="content motif">{children}</main>
      </div>
    </div>
  )
}
