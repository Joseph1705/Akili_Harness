/** Design screen D — create an agent from a pack: choose, configure, test on 5 documents. */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ago, api, ApiError, money } from '../api'
import { ReportPicker } from '../components/ReportPicker'
import { Shell } from '../components/Shell'
import { Icon, type IconName } from '../icons'
import { can, useSession } from '../state'

interface Pack { id: string; name: string; description: string; meta: string; icon: string; available: boolean; defaultAgentName: string }
interface Agent { id: string; name: string; status: string; pack_id: string; last_action_at: string | null; docs_total: number }
interface TestResult { filename: string; ok: boolean; report?: string; client?: string; total_cents?: number; currency?: string; attention?: number; error?: string; checks?: Array<{ title: string; note: string; status: string }> }
const ICONS: Record<string, IconName> = { doc: 'doc', bank: 'bank', pay: 'pay', cart: 'cart', shield: 'shield', mail: 'mail' }

export function Packs() {
  const { me, toast } = useSession()
  const navigate = useNavigate()
  const [packs, setPacks] = useState<Pack[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [selected, setSelected] = useState('facturation-sous-traitance')
  const [step, setStep] = useState(1)
  const [name, setName] = useState('Agent Facturation')
  const [lang, setLang] = useState('fr')
  const [files, setFiles] = useState<File[]>([])
  const [results, setResults] = useState<TestResult[] | null>(null)
  const [testAgent, setTestAgent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const allowed = can.configure(me?.org?.role)

  const loadAgents = () => api.get<{ agents: Agent[] }>('/api/agents').then(r => setAgents(r.agents))
  useEffect(() => { api.get<{ packs: Pack[] }>('/api/packs').then(r => setPacks(r.packs)); void loadAgents() }, [])
  const pack = packs.find(p => p.id === selected)

  async function create(): Promise<string | null> {
    try {
      const r = await api.post<{ agent: Agent }>('/api/agents', { packId: selected, name, language: lang })
      await loadAgents()
      return r.agent.id
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err'); return null }
  }

  async function runTest() {
    setBusy(true)
    try {
      const id = testAgent ?? await create()
      if (!id) return
      setTestAgent(id)
      const fd = new FormData()
      files.forEach(f => fd.append('file', f, f.name))
      const r = await api.post<{ results: TestResult[] }>(`/api/agents/${id}/test`, fd)
      setResults(r.results)
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  async function toggle(a: Agent) {
    try { await api.patch(`/api/agents/${a.id}`, { status: a.status === 'active' ? 'paused' : 'active' }); await loadAgents() }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') }
  }

  return (
    <Shell crumb="Agents › Nouvel agent" title="Créer un agent à partir d'un pack">
      <div className="page" style={{ maxWidth: 1180 }}>
        <div className="stepper">
          {['Choisir un pack', 'Configurer', 'Tester sur 5 documents'].map((l, i) => (
            <span key={l} className={`step${step === i + 1 ? ' on' : step > i + 1 ? ' done' : ''}`}>{i + 1} {l}</span>
          ))}
        </div>
        <div className="two-col" style={{ gridTemplateColumns: '1.6fr 1fr', marginTop: 0 }}>
          {step < 3 ? (
            <div className="pack-grid">
              {packs.map(p => (
                <button key={p.id} type="button" className={`pack${selected === p.id ? ' on' : ''}${p.available ? '' : ' off'}`} aria-pressed={selected === p.id}
                  onClick={() => { if (!p.available) return toast(`Le pack « ${p.name} » arrive bientôt.`); setSelected(p.id); setName(p.defaultAgentName); setStep(2) }}>
                  <span className="ico"><Icon name={ICONS[p.icon] ?? 'doc'} size={16} /></span>
                  {selected === p.id && <span className="tag badge solid">Sélectionné</span>}
                  {!p.available && <span className="tag badge neutral">Bientôt</span>}
                  <h3>{p.name}</h3><span className="d">{p.description}</span><span className="meta">{p.meta}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="card card-pad stack">
              <h2 style={{ fontSize: 18 }}>Tester sur 5 rapports</h2>
              <p className="small muted" style={{ margin: 0 }}>Essai à blanc : rien n'est enregistré, aucun crédit n'est consommé, aucune facture n'est créée.</p>
              <ReportPicker files={files} onChange={setFiles} max={5} />
              <button className="btn primary" disabled={busy || files.length === 0} onClick={runTest}>{busy ? <span className="spinner" /> : `Lancer le test (${files.length})`}</button>
              {results && (
                <table className="doc-table">
                  <thead><tr><th>Rapport</th><th>Résultat</th><th className="right">Total TTC</th></tr></thead>
                  <tbody>{results.map(r => (
                    <tr key={r.filename}>
                      <td><div className="small">{r.filename}</div>{r.client && <div className="tiny muted">{r.client}</div>}</td>
                      <td>{r.ok ? (r.attention ? <span className="badge alert">{r.attention} à vérifier</span> : <span className="badge green">Prêt</span>) : <span className="badge reject">Échec</span>}
                        {r.error && <div className="tiny muted">{r.error}</div>}
                        {r.checks?.filter(c => c.status === 'warning' || c.status === 'error').map(c => <div key={c.title} className="tiny muted">{c.title} — {c.note}</div>)}</td>
                      <td className="right mono small">{r.total_cents != null ? money(r.total_cents, r.currency) : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {results && <button className="btn" onClick={() => navigate('/sessions/nouvelle')}>L'agent est prêt : déposer de vrais rapports</button>}
            </div>
          )}
          <div className="card panel">
            <div><div className="eyebrow">Pack choisi</div><h2 style={{ fontSize: 20 }}>{pack?.name ?? '—'}</h2></div>
            <div className="field"><label htmlFor="agent-name">Nom de l'agent</label><input id="agent-name" className="input" value={name} onChange={e => setName(e.target.value)} disabled={!!testAgent} /></div>
            <div className="field"><label>Source des rapports</label><input className="input" value="Dépôt dans une session" disabled /><span className="hint">Dossier surveillé et boîte e-mail : bientôt.</span></div>
            <div className="field"><label>Langue des documents</label>
              <div className="segmented">{[['fr', 'Français'], ['en', 'English'], ['sw', 'Kiswahili']].map(([k, l]) => <button key={k} type="button" aria-pressed={lang === k} onClick={() => setLang(k!)} disabled={!!testAgent}>{l}</button>)}</div>
            </div>
            <div className="callout"><Icon name="check" size={16} /><span><b>Validation humaine avant tout envoi</b>Obligatoire. L'agent prépare, vous décidez.</span></div>
            <p className="tiny muted" style={{ margin: 0 }}>Les montants et la TVA sont calculés par le code à partir de vos contrats. Aucun document n'est envoyé à un fournisseur externe.</p>
            {allowed ? (<>
              {step < 3 && <button className="btn primary" disabled={!pack?.available || name.trim().length < 2} onClick={() => setStep(3)}>Tester sur 5 documents</button>}
              {!testAgent && <button className="btn" disabled={!pack?.available || busy} onClick={async () => { const id = await create(); if (id) { toast('Agent créé.'); navigate('/sessions/nouvelle') } }}>Créer sans tester</button>}
            </>) : <p className="small muted">Seuls les propriétaires et administrateurs créent des agents.</p>}
          </div>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head"><h2 style={{ fontSize: 17 }}>Vos agents</h2><span className="small muted">{agents.length}</span></div>
          {agents.length === 0 && <div className="empty">Aucun agent pour l'instant.</div>}
          {agents.map(a => (
            <div className="list-row" key={a.id}>
              <span className={`agent-dot${a.status === 'active' ? '' : ' off'}`} />
              <div className="grow"><b>{a.name}</b><div className="tiny muted">{packs.find(p => p.id === a.pack_id)?.name} · {a.docs_total} document{a.docs_total > 1 ? 's' : ''}{a.last_action_at ? ` · ${ago(a.last_action_at)}` : ''}</div></div>
              <span className={`badge ${a.status === 'active' ? 'green' : 'neutral'}`}>{a.status === 'active' ? 'Actif' : 'En pause'}</span>
              {allowed && <button className="btn small" onClick={() => toggle(a)}>{a.status === 'active' ? 'Mettre en pause' : 'Réactiver'}</button>}
            </div>
          ))}
        </div>
      </div>
    </Shell>
  )
}
