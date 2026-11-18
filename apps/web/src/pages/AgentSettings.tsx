/** One agent: its instructions (versioned system prompt), its tools and whether it reads the knowledge base. */
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, ago } from '../api'
import { Shell } from '../components/Shell'
import { can, useSession } from '../state'

interface Version { id: string; version: number; identity: string; instructions: string; style: string; restrictions: string; note: string | null; created_at: string }
interface Data { versions: Version[]; activeId: string | null; defaults: Omit<Version, 'id' | 'version' | 'note' | 'created_at'>; platformRules: string; settings: { use_knowledge: boolean; tools: string[] }; tools: string[] }

const TOOL_LABEL: Record<string, string> = {
  rechercher_connaissances: 'Chercher dans la base de connaissances', lister_factures: 'Lister les factures', solde_credits: 'Consulter le solde de crédits',
  documents_a_verifier: 'Voir les documents à vérifier', chercher_emails: 'Chercher dans Gmail (Google connecté)',
  proposer_email: 'Proposer un e-mail — validation requise', proposer_ligne_sheets: 'Proposer des lignes Google Sheets — validation requise',
}
const FIELDS = [
  ['identity', 'Identité et rôle', 'Qui est l\'agent, pour qui il travaille.'],
  ['instructions', 'Instructions et objectifs', 'Ce qu\'il doit faire, dans quel ordre, avec quelles priorités.'],
  ['style', 'Style de communication', 'Ton, langue, longueur des réponses, format des montants.'],
  ['restrictions', 'Restrictions', 'Ce qu\'il ne doit jamais faire ou dire.'],
] as const

export function AgentSettings() {
  const { id } = useParams()
  const { me, toast } = useSession()
  const [data, setData] = useState<Data | null>(null)
  const [agent, setAgent] = useState<{ name: string; status: string } | null>(null)
  const [draft, setDraft] = useState<{ identity: string; instructions: string; style: string; restrictions: string; note: string }>({ identity: '', instructions: '', style: '', restrictions: '', note: '' })
  const [settings, setSettings] = useState<{ use_knowledge: boolean; tools: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const admin = can.configure(me?.org?.role)

  const load = useCallback(async () => {
    const [p, a] = await Promise.all([api.get<Data>(`/api/agents/${id}/prompts`), api.get<{ agent: { name: string; status: string } }>(`/api/agents/${id}`)])
    setData(p); setAgent(a.agent); setSettings(p.settings)
    const active = p.versions.find(v => v.id === p.activeId)
    const base = active ?? p.defaults
    setDraft({ identity: base.identity, instructions: base.instructions, style: base.style, restrictions: base.restrictions, note: '' })
  }, [id])
  useEffect(() => { void load().catch(() => setData(null)) }, [load])

  async function saveVersion() {
    setBusy(true)
    try { const r = await api.post<{ version: Version }>(`/api/agents/${id}/prompts`, { ...draft, note: draft.note || undefined, activate: true }); toast(`Version ${r.version.version} enregistrée et active.`); await load() }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }
  async function activate(v: Version) {
    try { await api.post(`/api/agents/${id}/prompts/${v.id}/activate`); toast(`Version ${v.version} active.`); await load() } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') }
  }
  async function saveSettings() {
    if (!settings) return
    try { await api.patch(`/api/agents/${id}/ai`, settings); toast('Outils enregistrés.') } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') }
  }

  if (!data || !settings) return <Shell crumb="Agents" title="Agent"><div className="page empty"><span className="spinner" /></div></Shell>
  return (
    <Shell crumb="Agents › Configuration" title={agent?.name ?? 'Agent'}>
      <div className="page stack" style={{ gap: 16, maxWidth: 1100 }}>
        <p className="muted" style={{ margin: 0 }}>Ces instructions sont envoyées au modèle à chaque réponse de l'agent, après les règles de la plateforme. Chaque enregistrement crée une nouvelle version ; vous pouvez revenir à une version précédente à tout moment. <Link to="/activite-ia">Voir l'activité</Link></p>
        <div className="two-col" style={{ gridTemplateColumns: '1.5fr 1fr', marginTop: 0 }}>
          <div className="card card-pad stack">
            {FIELDS.map(([k, label, hint]) => (
              <div className="field" key={k}><label htmlFor={`p-${k}`}>{label}</label>
                <textarea id={`p-${k}`} className="input" rows={k === 'instructions' ? 6 : 3} value={draft[k]} disabled={!admin} onChange={e => setDraft({ ...draft, [k]: e.target.value })} /><span className="hint">{hint}</span></div>
            ))}
            {admin && <div className="row"><input className="input" placeholder="Note de version (facultatif)" value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} /><button className="btn primary" disabled={busy} onClick={saveVersion}>Enregistrer une nouvelle version</button></div>}
          </div>
          <div className="stack" style={{ gap: 16 }}>
            <div className="card card-pad stack">
              <b>Versions</b>
              {data.versions.length === 0 && <span className="small muted">Aucune version : l'agent utilise les instructions par défaut du pack.</span>}
              {data.versions.map(v => (
                <div className="spread" key={v.id}>
                  <span className="small">v{v.version} · {ago(v.created_at)}{v.note ? ` · ${v.note}` : ''}</span>
                  {v.id === data.activeId ? <span className="badge green">Active</span> : admin && <button className="btn small" onClick={() => activate(v)}>Activer</button>}
                </div>
              ))}
            </div>
            <div className="card card-pad stack">
              <b>Outils et connaissances</b>
              <label className="small row" style={{ gap: 6 }}><input type="checkbox" disabled={!admin} checked={settings.use_knowledge} onChange={e => setSettings({ ...settings, use_knowledge: e.target.checked })} /> Consulter la base de connaissances avant de répondre</label>
              {data.tools.map(t => (
                <label key={t} className="small row" style={{ gap: 6 }}><input type="checkbox" disabled={!admin} checked={settings.tools.includes(t)} onChange={e => setSettings({ ...settings, tools: e.target.checked ? [...settings.tools, t] : settings.tools.filter(x => x !== t) })} /> {TOOL_LABEL[t] ?? t}</label>
              ))}
              <span className="tiny muted">Un agent n'a jamais plus de droits que la personne qui lui parle. Les outils des serveurs MCP se règlent dans Paramètres › Outils MCP.</span>
              {admin && <button className="btn small" onClick={saveSettings}>Enregistrer les outils</button>}
            </div>
            <details className="card card-pad"><summary className="small"><b>Règles de la plateforme (non modifiables)</b></summary><div className="code-block" style={{ marginTop: 8 }}>{data.platformRules}</div></details>
          </div>
        </div>
      </div>
    </Shell>
  )
}
