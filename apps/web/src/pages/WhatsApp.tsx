/** WhatsApp conversations (Business Platform): messages received, replies sent by a person, agent drafts to approve. */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, api, ApiError, time, uuid } from '../api'
import { Shell } from '../components/Shell'
import { can, useSession } from '../state'

interface Conv { id: string; contact_wa_id: string; contact_name: string | null; last_inbound_at: string | null; last_message_at: string; last_body: string | null; drafts: number }
interface Msg { id: string; direction: 'in' | 'out'; body: string; status: string; author: string | null; approval_id: string | null; created_at: string }

export function WhatsApp() {
  const { me, toast } = useSession()
  const [convs, setConvs] = useState<Conv[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const loadConvs = useCallback(() => api.get<{ conversations: Conv[] }>('/api/whatsapp/conversations').then(r => { setConvs(r.conversations); setCurrent(c => c ?? r.conversations[0]?.id ?? null) }).catch(() => setConvs([])), [])
  const loadMsgs = useCallback(() => current ? api.get<{ messages: Msg[] }>(`/api/whatsapp/conversations/${current}`).then(r => setMessages(r.messages)).catch(() => undefined) : Promise.resolve(), [current])
  useEffect(() => { void loadConvs(); const t = window.setInterval(() => void loadConvs(), 8000); return () => window.clearInterval(t) }, [loadConvs])
  useEffect(() => { void loadMsgs(); const t = window.setInterval(() => void loadMsgs(), 5000); return () => window.clearInterval(t) }, [loadMsgs])

  const conv = convs?.find(c => c.id === current)
  const windowOpen = conv?.last_inbound_at ? Date.now() - Date.parse(conv.last_inbound_at) < 24 * 3600_000 : false
  async function send() {
    if (!current || !text.trim()) return
    setBusy(true)
    try { await api.post(`/api/whatsapp/conversations/${current}/messages`, { text }, { 'idempotency-key': uuid() }); setText(''); await loadMsgs() }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  return (
    <Shell crumb="Connecteurs" title="WhatsApp">
      <div className="page" style={{ maxWidth: 1180 }}>
        {convs && convs.length === 0 ? (
          <div className="card empty">Aucune conversation. Connectez votre numéro WhatsApp Business dans <Link to="/parametres?onglet=connecteurs">Paramètres › Connecteurs</Link> ; les messages reçus apparaîtront ici.</div>
        ) : (
          <div className="two-col" style={{ gridTemplateColumns: '320px 1fr', marginTop: 0 }}>
            <div className="card">{convs?.map(c => (
              <button key={c.id} className={`list-row${c.id === current ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', background: c.id === current ? 'var(--surface-2)' : 'transparent', border: 0, cursor: 'pointer' }} onClick={() => setCurrent(c.id)}>
                <div className="grow"><b>{c.contact_name ?? `+${c.contact_wa_id}`}</b><div className="tiny muted">{(c.last_body ?? '').slice(0, 60)}</div></div>
                <span className="tiny muted">{ago(c.last_message_at)}</span>{c.drafts > 0 && <span className="badge alert">{c.drafts}</span>}
              </button>
            ))}</div>
            <div className="card stack" style={{ gap: 0 }}>
              <div className="card-head"><b>{conv ? (conv.contact_name ?? `+${conv.contact_wa_id}`) : '—'}</b><span className="small muted">{windowOpen ? 'Réponse libre possible (moins de 24 h)' : 'Plus de 24 h : modèle approuvé par Meta requis'}</span></div>
              <div className="wa-thread">{messages.map(m => (
                <div key={m.id} className={`wa-msg${m.direction === 'out' ? ' out' : ''}${m.status === 'draft' ? ' draft' : ''}`}>
                  <div>{m.body}</div>
                  <div className="tiny muted">{time(m.created_at)}{m.direction === 'out' ? ` · ${m.status === 'draft' ? 'brouillon de l\'agent — ' : ''}${m.status === 'draft' ? '' : m.status}${m.author ? ` · ${m.author === 'agent' ? 'agent' : m.author}` : ''}` : ''}
                    {m.status === 'draft' && <> <Link to="/approbations">à approuver</Link></>}</div>
                </div>
              ))}</div>
              {can.operate(me?.org?.role) && (
                <div className="row" style={{ padding: 12, borderTop: '1px solid var(--line)' }}>
                  <input className="input" placeholder={windowOpen ? 'Votre réponse…' : 'Fenêtre de 24 h fermée'} disabled={!windowOpen} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send() }} />
                  <button className="btn primary" disabled={busy || !windowOpen || !text.trim()} onClick={send}>Envoyer</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Shell>
  )
}
