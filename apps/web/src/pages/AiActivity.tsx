/** AI activity of the organization (administrators): runs, steps, durations, errors and usage — no prices. */
import { useEffect, useState } from 'react'
import { api, date } from '../api'
import { Shell } from '../components/Shell'

interface Run { id: string; purpose: string; status: string; provider: string | null; model: string | null; tier: string | null; prompt_version: number | null; input_tokens: number; output_tokens: number; cached: boolean; duration_ms: number | null; error: string | null; created_at: string; agent_name: string | null; user_email: string | null; steps: number }
interface Step { kind: string; name: string; status: string; detail: Record<string, unknown> | null; duration_ms: number | null }
interface Usage { days: Array<{ day: string; runs: number; tokens: number; errors: number; avg_ms: number }>; purposes: Array<{ purpose: string; runs: number; cached: number; ok: number }>; models: Array<{ provider: string; model: string; runs: number }> }

const PURPOSE: Record<string, string> = { chat: 'Conversation', extraction: 'Lecture de document', embedding: 'Indexation', eval: 'Évaluation', whatsapp: 'Brouillon WhatsApp' }
const STATUS: Record<string, [string, string]> = { ok: ['Réussi', 'green'], error: ['Erreur', 'reject'], blocked: ['Bloqué', 'alert'], refused: ['Décliné', 'alert'], awaiting_approval: ['Attend une validation', 'alert'], running: ['En cours', 'neutral'] }
const KIND: Record<string, string> = { model: 'Modèle', retrieval: 'Recherche', tool: 'Outil', guardrail: 'Garde-fou', approval: 'Validation demandée', fallback: 'Repli', cache: 'Cache', budget: 'Plafond' }

export function AiActivity() {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [purpose, setPurpose] = useState('')
  const [open, setOpen] = useState<{ id: string; steps: Step[]; run: Record<string, unknown> } | null>(null)
  useEffect(() => { setRuns(null); api.get<{ runs: Run[] }>(`/api/ai/runs${purpose ? `?purpose=${purpose}` : ''}`).then(r => setRuns(r.runs)).catch(() => setRuns([])) }, [purpose])
  useEffect(() => { api.get<Usage>('/api/ai/usage').then(setUsage).catch(() => undefined) }, [])
  const show = async (id: string) => { const r = await api.get<{ run: Record<string, unknown>; steps: Step[] }>(`/api/ai/runs/${id}`); setOpen({ id, ...r }) }
  const total = usage?.days.reduce((a, d) => ({ runs: a.runs + d.runs, errors: a.errors + d.errors, tokens: a.tokens + Number(d.tokens) }), { runs: 0, errors: 0, tokens: 0 })

  return (
    <Shell crumb="Agents" title="Activité de l'IA">
      <div className="page stack" style={{ gap: 16 }}>
        <div className="stat-grid">
          <div className="card stat"><span className="eyebrow">Exécutions (30 j)</span><span className="big">{total?.runs ?? '–'}</span><span className="small muted">Erreurs : {total?.errors ?? 0}</span></div>
          <div className="card stat"><span className="eyebrow">Jetons traités (30 j)</span><span className="big" style={{ fontSize: 28 }}>{total ? total.tokens.toLocaleString('fr-FR') : '–'}</span><span className="small muted">Suivi interne ; vous payez par document, pas au jeton.</span></div>
          <div className="card stat"><span className="eyebrow">Usages</span>{usage?.purposes.map(p => <span key={p.purpose} className="small">{PURPOSE[p.purpose] ?? p.purpose} : {p.runs}{p.cached ? ` (${p.cached} en cache)` : ''}</span>)}</div>
          <div className="card stat"><span className="eyebrow">Modèles</span>{usage?.models.map(m => <span key={m.model} className="small mono">{m.model} · {m.runs}</span>)}</div>
        </div>
        <div className="card">
          <div className="card-head"><b>Exécutions</b><select className="input" style={{ width: 'auto' }} value={purpose} onChange={e => setPurpose(e.target.value)} aria-label="Usage"><option value="">Tous les usages</option>{Object.entries(PURPOSE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          {runs === null ? <div className="empty"><span className="spinner" /></div> : runs.length === 0 ? <div className="empty">Aucune exécution.</div> : (
            <table className="table"><thead><tr><th>Date</th><th>Usage</th><th>État</th><th>Modèle</th><th className="right">Jetons</th><th className="right">Durée</th><th /></tr></thead>
              <tbody>{runs.map(r => {
                const [label, tone] = STATUS[r.status] ?? [r.status, 'neutral']
                return (
                  <tr key={r.id}><td className="small muted">{new Date(r.created_at).toLocaleString('fr-FR')}</td>
                    <td>{PURPOSE[r.purpose] ?? r.purpose}<div className="tiny muted">{r.agent_name ?? ''}{r.prompt_version ? ` · prompt v${r.prompt_version}` : ''}{r.user_email ? ` · ${r.user_email}` : ''}</div></td>
                    <td><span className={`badge ${tone}`}>{label}</span>{r.cached && <div className="tiny muted">cache</div>}{r.error && <div className="tiny muted">{r.error.slice(0, 80)}</div>}</td>
                    <td className="small mono">{r.model ?? '—'}</td>
                    <td className="right mono small">{r.input_tokens + r.output_tokens}</td>
                    <td className="right mono small">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} s` : '—'}</td>
                    <td className="right"><button className="btn small" onClick={() => void show(r.id)}>Étapes ({r.steps})</button></td></tr>
                )
              })}</tbody></table>
          )}
        </div>
        {open && (
          <div className="card card-pad stack">
            <div className="spread"><b>Étapes de l'exécution du {date(String(open.run.created_at))}</b><button className="btn small ghost" onClick={() => setOpen(null)}>Fermer</button></div>
            {open.steps.map((s, i) => (
              <div key={i} className="stack" style={{ gap: 2, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                <span className="small"><b>{KIND[s.kind] ?? s.kind}</b> · {s.name} · <span className={`badge ${s.status === 'ok' ? 'green' : s.status === 'error' ? 'reject' : 'alert'}`}>{s.status}</span>{s.duration_ms != null ? <span className="tiny muted"> · {s.duration_ms} ms</span> : null}</span>
                {s.detail && <div className="code-block">{JSON.stringify(s.detail, null, 2)}</div>}
              </div>
            ))}
            {typeof open.run.request_excerpt === 'string' && <><span className="tiny muted">Demande (pseudonymisée)</span><div className="code-block">{open.run.request_excerpt}</div></>}
            {typeof open.run.response_excerpt === 'string' && <><span className="tiny muted">Réponse (pseudonymisée)</span><div className="code-block">{open.run.response_excerpt}</div></>}
          </div>
        )}
      </div>
    </Shell>
  )
}
