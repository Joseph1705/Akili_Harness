/** Design screen B — Nouvelle session. */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { ReportPicker } from '../components/ReportPicker'
import { Shell } from '../components/Shell'
import { useSession } from '../state'

interface Agent { id: string; name: string; status: string; pack_id: string }
const COMMANDS = [
  { cmd: '/facturer', desc: 'Rapports d\'activité → projets de facture' },
  { cmd: '/validations', desc: 'Factures qui attendent votre validation' },
  { cmd: '/solde', desc: 'Crédits restants' },
  { cmd: '/agents', desc: 'État de vos agents' },
]

export function NewSession() {
  const { me, toast } = useSession()
  const navigate = useNavigate()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [agentId, setAgentId] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<{ agents: Agent[] }>('/api/agents').then(r => {
      const active = r.agents.filter(a => a.status === 'active')
      setAgents(active)
      if (active[0]) setAgentId(active[0].id)
    }).catch(() => setAgents([]))
  }, [])

  async function launch() {
    setBusy(true)
    try {
      if (files.length) {
        const fd = new FormData()
        fd.append('agentId', agentId)
        files.forEach(f => fd.append('file', f, f.name))
        const r = await api.post<{ sessionId: string }>('/api/documents', fd)
        navigate(`/sessions/${r.sessionId}`)
      } else if (text.trim()) {
        const s = await api.post<{ session: { id: string } }>('/api/sessions', { title: text.trim().slice(0, 60), agentId: agentId || undefined })
        await api.post(`/api/sessions/${s.session.id}/messages`, { text: text.trim() })
        navigate(`/sessions/${s.session.id}`)
      }
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  const model = me?.org?.plan === 'solo' ? 'DeepSeek' : 'Claude Opus 5.5'
  return (
    <Shell crumb="Session" title="Nouvelle session">
      <div className="welcome" style={{ minHeight: 'auto', paddingTop: 48 }}>
        <img className="light-only" src="/brand/tete-vert-128.png" width={48} height={48} alt="" />
        <img className="dark-only" src="/brand/tete-ivoire-128.png" width={48} height={48} alt="" />
        <h1 style={{ fontSize: 28 }}>Que doit faire l'agent aujourd'hui ?</h1>
        <p className="muted" style={{ maxWidth: 560, margin: 0 }}>Déposez vos rapports d'activité ou tapez une commande. L'agent lit vos documents, agit étape par étape et vous demande avant chaque action importante.</p>
        {agents && agents.length === 0 && <div className="callout" style={{ maxWidth: 640 }}><span>◆</span><span><b>Aucun agent actif.</b> Créez d'abord un agent depuis <Link to="/packs">Packs d'agents</Link>.</span></div>}
        <div className="big-prompt" style={{ marginTop: 14 }}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <span className="mono" style={{ color: 'var(--green)' }}>&gt;</span>
            <textarea aria-label="Instruction" value={text} onChange={e => setText(e.target.value)} placeholder="Ex. : /facturer — ou déposez les rapports d'octobre ci-dessous" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void launch() } }} />
          </div>
          <div className="spread" style={{ marginTop: 8, alignItems: 'flex-end' }}>
            <div className="chips grow" style={{ justifyContent: 'flex-start' }}>
              <span className="chip on">pack : Facturation</span>
              {agents && agents.length > 1 ? (
                <select className="chip" value={agentId} onChange={e => setAgentId(e.target.value)} aria-label="Agent">{agents.map(a => <option key={a.id} value={a.id}>agent : {a.name}</option>)}</select>
              ) : agents?.[0] && <span className="chip">agent : {agents[0].name}</span>}
              <span className="chip">calculs : code · assistant : {model}</span>
            </div>
            <button className="btn primary small" disabled={busy || (!files.length && !text.trim()) || (files.length > 0 && !agentId)} onClick={launch}>{busy ? <span className="spinner" /> : 'Lancer ↵'}</button>
          </div>
        </div>
        <div style={{ width: '100%', maxWidth: 640 }}><ReportPicker files={files} onChange={setFiles} /></div>
        <div className="cmd-grid" style={{ marginTop: 6 }}>
          {COMMANDS.map(c => <button key={c.cmd} className="cmd" onClick={() => setText(c.cmd)}><b>{c.cmd}</b><div>{c.desc}</div></button>)}
        </div>
      </div>
    </Shell>
  )
}
