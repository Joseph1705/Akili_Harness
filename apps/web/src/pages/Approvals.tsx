/** Actions proposed by agents that wait for a person (rule 7): approve executes once, reject cancels. */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, ago } from '../api'
import { Shell } from '../components/Shell'
import { useSession } from '../state'

interface Approval {
  id: string; kind: string; summary: string; payload: Record<string, unknown>; permission: string; status: string; session_id: string | null
  reason: string | null; error: string | null; created_at: string; decided_at: string | null; expires_at: string; requested_by_email: string | null; decided_by_email: string | null
}
const KIND: Record<string, string> = { 'gmail.send': 'E-mail (Gmail)', 'sheets.append': 'Google Sheets', 'whatsapp.send': 'Message WhatsApp', 'mcp.call': 'Outil externe (MCP)' }
const STATUS: Record<string, [string, string]> = {
  pending: ['En attente', 'alert'], approved: ['Approuvée', 'neutral'], rejected: ['Refusée', 'reject'], executed: ['Exécutée', 'green'], failed: ['Échec', 'reject'], expired: ['Expirée', 'neutral'],
}

function Details({ a }: { a: Approval }) {
  const p = a.payload
  if (a.kind === 'gmail.send') return <div className="small"><div><b>À :</b> {String(p.to)}</div><div><b>Objet :</b> {String(p.subject)}</div><div className="code-block" style={{ marginTop: 6 }}>{String(p.body)}</div></div>
  if (a.kind === 'whatsapp.send') return <div className="code-block">{String(p.text)}</div>
  if (a.kind === 'sheets.append') return <div className="small"><div><b>Feuille :</b> <span className="mono">{String(p.spreadsheetId)}</span> · {String(p.range)}</div><div className="code-block">{(p.values as string[][]).map(r => r.join(' | ')).join('\n')}</div></div>
  return <div className="code-block">{JSON.stringify(p.arguments ?? p, null, 2)}</div>
}

export function Approvals() {
  const { toast } = useSession()
  const [tab, setTab] = useState<'pending' | 'all'>('pending')
  const [rows, setRows] = useState<Approval[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => api.get<{ approvals: Approval[] }>(`/api/ai/approvals${tab === 'pending' ? '?status=pending' : ''}`).then(r => setRows(r.approvals)).catch(() => setRows([])), [tab])
  useEffect(() => { setRows(null); void load() }, [load])

  async function decide(a: Approval, decision: 'approve' | 'reject') {
    const reason = decision === 'reject' ? window.prompt('Raison du refus (facultatif) ?') ?? undefined : undefined
    setBusy(a.id)
    try {
      const r = await api.post<{ status: string; error?: string }>(`/api/ai/approvals/${a.id}/${decision}`, reason ? { reason } : {})
      toast(r.status === 'executed' ? 'Action exécutée.' : r.status === 'rejected' ? 'Action refusée.' : `Échec : ${r.error ?? ''}`, r.status === 'failed' ? 'err' : 'ok')
      await load()
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(null) }
  }

  return (
    <Shell crumb="Agents" title="Actions à approuver">
      <div className="page" style={{ maxWidth: 1000 }}>
        <p className="muted" style={{ marginTop: 0 }}>Un agent ne fait rien sortir seul : chaque e-mail, message ou écriture dans un service externe attend ici votre décision. Une demande expire après 7 jours.</p>
        <div className="tabs" role="tablist">{([['pending', 'En attente'], ['all', 'Historique']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
        {rows === null ? <div className="empty"><span className="spinner" /></div> : rows.length === 0 ? <div className="card empty">{tab === 'pending' ? 'Rien à approuver.' : 'Aucune demande.'}</div> : (
          <div className="stack" style={{ gap: 12 }}>{rows.map(a => {
            const [label, tone] = STATUS[a.status] ?? [a.status, 'neutral']
            return (
              <div className="card card-pad stack" key={a.id} style={{ gap: 8 }}>
                <div className="spread"><b>{KIND[a.kind] ?? a.kind} — {a.summary}</b><span className={`badge ${tone}`}>{label}</span></div>
                <span className="tiny muted">Proposée {ago(a.created_at)} par {a.requested_by_email ?? 'un agent (réponse automatique)'}{a.decided_by_email ? ` · décidée par ${a.decided_by_email}` : ''}{a.session_id ? <> · <Link to={`/sessions/${a.session_id}`}>voir la session</Link></> : null}</span>
                <Details a={a} />
                {a.error && <span className="small" style={{ color: 'var(--reject)' }}>{a.error}</span>}
                {a.reason && <span className="small muted">Motif : {a.reason}</span>}
                {a.status === 'pending' && (
                  <div className="row"><button className="btn primary" disabled={busy !== null} onClick={() => decide(a, 'approve')}>Approuver et exécuter</button><button className="btn danger" disabled={busy !== null} onClick={() => decide(a, 'reject')}>Refuser</button></div>
                )}
              </div>
            )
          })}</div>
        )}
      </div>
    </Shell>
  )
}
