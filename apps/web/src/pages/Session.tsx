/** Design screen A — Session: the agent's steps, the documents it handled, and the prompt. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, money, time } from '../api'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { useSession } from '../state'

interface Ev { id: number; role: 'user' | 'agent' | 'tool' | 'system'; content: { text?: string; name?: string; arg?: string; out?: string; items?: Array<{ label: string; value: string; href?: string }> }; created_at: string }
interface Doc { id: string; filename: string; status: string; error: string | null; invoice_id: string | null; invoice_number: string | null; invoice_status: string | null; total_cents: number | null; currency: string | null }
interface Data { session: { id: string; title: string; agent_name: string | null; agent_id: string | null; pack_id: string | null }; events: Ev[]; documents: Doc[] }

const STATUS: Record<string, [string, string]> = {
  queued: ['En file', 'neutral'], processing: ['Lecture…', 'neutral'], waiting_credits: ['Crédits épuisés', 'alert'],
  done: ['Traité', 'green'], duplicate: ['Doublon ignoré', 'neutral'], failed: ['Échec', 'reject'],
}

export function SessionPage() {
  const { id } = useParams()
  const { me, toast } = useSession()
  const [data, setData] = useState<Data | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => api.get<Data>(`/api/sessions/${id}`).then(setData).catch(() => setData(null)), [id])
  useEffect(() => { void load() }, [load])
  const working = data?.documents.some(d => d.status === 'queued' || d.status === 'processing')
  useEffect(() => {
    if (!working) return
    const t = window.setInterval(load, 1200)
    return () => window.clearInterval(t)
  }, [working, load])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [data?.events.length])

  async function send() {
    if (!text.trim()) return
    setBusy(true)
    try { await api.post(`/api/sessions/${id}/messages`, { text }); setText(''); await load() }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  async function attach(files: FileList | null) {
    if (!files?.length || !data) return
    const agentId = data.session.agent_id ?? (await api.get<{ agents: Array<{ id: string; status: string }> }>('/api/agents')).agents.find(a => a.status === 'active')?.id
    if (!agentId) return toast("Créez d'abord un agent.", 'err')
    const fd = new FormData()
    fd.append('agentId', agentId)
    fd.append('sessionId', data.session.id)
    ;[...files].forEach(f => fd.append('file', f, f.name))
    try { await api.post('/api/documents', fd); await load() } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') }
  }

  const empty = data && data.events.length === 0
  return (
    <Shell crumb={`Session · ${data?.session.agent_name ?? 'assistant'}`} title={data?.session.title ?? '…'}>
      <div className="session">
        <div className="transcript">
          {empty ? (
            <div className="welcome">
              <div className="welcome-diamond"><img className="light-only" src="/brand/tete-vert-128.png" alt="" /><img className="dark-only" src="/brand/tete-ivoire-128.png" alt="" /></div>
              <h1 style={{ fontSize: 24 }}>Bonjour {me?.user.first_name}.</h1>
              <p className="muted" style={{ margin: 0 }}>L'agent est prêt. Vos fichiers restent sur ce serveur.</p>
              <div className="chips">{['/facturer', '/validations', '/solde', '/aide'].map(c => <button key={c} className="chip" onClick={() => setText(c)}>{c}</button>)}</div>
            </div>
          ) : (
            <div className="transcript-inner">
              {data?.events.map(e => <Event key={e.id} ev={e} />)}
              {working && <div className="ev-agent"><span className="spinner" /> <span className="muted">Je lis les rapports…</span></div>}
              {data && data.documents.length > 0 && (
                <table className="doc-table">
                  <thead><tr><th>Document</th><th>État</th><th>Facture</th><th className="right">Montant</th><th /></tr></thead>
                  <tbody>{data.documents.map(d => {
                    const [label, tone] = STATUS[d.status] ?? [d.status, 'neutral']
                    return (
                      <tr key={d.id}>
                        <td><div>{d.filename}</div>{d.error && <div className="tiny muted">{d.error}</div>}</td>
                        <td><span className={`badge ${tone}`}>{label}</span></td>
                        <td className="mono small">{d.invoice_number ?? '—'}{d.invoice_status === 'validated' && <span className="badge green" style={{ marginLeft: 6 }}>validée</span>}</td>
                        <td className="right mono small">{d.total_cents != null ? money(d.total_cents, d.currency ?? 'USD') : '—'}</td>
                        <td className="right">{d.invoice_id && <Link className="btn small" to={`/validations/${d.invoice_id}`}>Ouvrir</Link>}</td>
                      </tr>
                    )
                  })}</tbody>
                </table>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>
        <div className="composer">
          <div className="composer-inner">
            <div className="prompt">
              <span className="caret">&gt;</span>
              <input aria-label="Message" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send() }} placeholder="Tapez une commande, ex. /validations" />
              <input ref={fileRef} type="file" multiple accept=".pdf,.xlsx,.csv" className="sr-only" onChange={e => { void attach(e.target.files); e.target.value = '' }} />
              <button className="btn small ghost" title="Joindre des rapports" onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} /></button>
              <button className="btn small primary" disabled={busy || !text.trim()} onClick={send}>Envoyer</button>
            </div>
            <div className="foot"><span>Entrée : envoyer · /aide : commandes</span><span style={{ color: 'var(--green-ink)' }}>◆ Fichiers stockés sur ce serveur</span></div>
          </div>
        </div>
      </div>
    </Shell>
  )
}

function Event({ ev }: { ev: Ev }) {
  if (ev.role === 'user') return <div className="ev-user">{ev.content.text} <span className="tiny">· {time(ev.created_at)}</span></div>
  if (ev.role === 'tool') return (
    <div className="ev-tool"><span style={{ color: 'var(--copper)' }}>● </span><span className="name">{ev.content.name}</span>(<span>{ev.content.arg}</span>)
      <div className="out">└ {ev.content.out}</div></div>
  )
  return (
    <div>
      <div className="ev-agent"><span>{ev.content.text}</span></div>
      {ev.content.items && ev.content.items.length > 0 && (
        <div className="ev-items">{ev.content.items.map(i => <div key={i.label}><span>{i.href ? <Link to={i.href}>{i.label}</Link> : i.label}</span><span className="muted">{i.value}</span></div>)}</div>
      )}
    </div>
  )
}
