/** Knowledge base (RAG): documents the agents read before answering, with search test, versions and deletion. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, ago } from '../api'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, useSession } from '../state'

interface KDoc { id: string; title: string; filename: string; kind: string; status: string; version: number; chunks: number; embedded: boolean; ocr_used: boolean; flagged: boolean; error: string | null; updated_at: string; created_by_email: string | null }
interface Source { n: number; title: string; heading: string | null; content: string; score: number; flagged: boolean }
const STATUS: Record<string, [string, string]> = { queued: ['En file', 'neutral'], processing: ['Indexation…', 'neutral'], ready: ['Prêt', 'green'], failed: ['Échec', 'reject'] }

export function Knowledge() {
  const { me, toast } = useSession()
  const [docs, setDocs] = useState<KDoc[] | null>(null)
  const [info, setInfo] = useState<{ vectors: boolean; embeddings: boolean }>({ vectors: false, embeddings: false })
  const [title, setTitle] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Source[] | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const [replaceId, setReplaceId] = useState<string | null>(null)
  const admin = can.configure(me?.org?.role)

  const load = useCallback(() => api.get<{ documents: KDoc[]; vectors: boolean; embeddings: boolean }>('/api/knowledge').then(r => { setDocs(r.documents); setInfo({ vectors: r.vectors, embeddings: r.embeddings }) }), [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!docs?.some(d => d.status === 'queued' || d.status === 'processing')) return
    const t = window.setInterval(() => void load(), 1500)
    return () => window.clearInterval(t)
  }, [docs, load])

  async function upload(file: File, replace?: string) {
    setBusy(true)
    try {
      const fd = new FormData()
      if (title.trim() && !replace) fd.append('title', title.trim())
      if (replace) fd.append('replaceId', replace)
      fd.append('file', file, file.name)
      await api.post('/api/knowledge', fd)
      toast(replace ? 'Nouvelle version en cours d\'indexation.' : 'Document ajouté : indexation en cours.')
      setTitle(''); await load()
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  async function search() {
    if (query.trim().length < 2) return
    try { setResults((await api.post<{ sources: Source[] }>('/api/knowledge/search', { query })).sources) } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') }
  }

  return (
    <Shell crumb="Agents" title="Base de connaissances">
      <div className="page stack" style={{ gap: 16, maxWidth: 1100 }}>
        <p className="muted" style={{ margin: 0 }}>Procédures, contrats, grilles tarifaires, règles internes : les agents cherchent ici avant de répondre et citent leurs sources. Ces documents restent dans votre organisation.
          {' '}{info.vectors && info.embeddings ? 'Recherche par le sens et par les mots.' : 'Recherche par les mots (la recherche par le sens s\'active avec un service d\'embeddings).'}</p>
        {admin && (
          <div className="card card-pad row" style={{ flexWrap: 'wrap' }}>
            <input className="input" style={{ maxWidth: 320 }} placeholder="Titre (facultatif)" value={title} onChange={e => setTitle(e.target.value)} />
            <input ref={fileRef} type="file" className="sr-only" accept=".pdf,.docx,.txt,.xlsx,.csv,image/*" onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }} />
            <input ref={replaceRef} type="file" className="sr-only" accept=".pdf,.docx,.txt,.xlsx,.csv,image/*" onChange={e => { const f = e.target.files?.[0]; if (f && replaceId) void upload(f, replaceId); e.target.value = '' }} />
            <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} /> Ajouter un document</button>
            <span className="small muted">PDF, Word, texte, Excel, CSV ou photo (lue par OCR).</span>
          </div>
        )}
        <div className="card">
          {docs === null ? <div className="empty"><span className="spinner" /></div> : docs.length === 0 ? <div className="empty">Aucun document pour l'instant.</div> : (
            <table className="table"><thead><tr><th>Document</th><th>État</th><th className="right">Passages</th><th>Mis à jour</th><th /></tr></thead>
              <tbody>{docs.map(d => {
                const [label, tone] = STATUS[d.status] ?? [d.status, 'neutral']
                return (
                  <tr key={d.id}>
                    <td><b>{d.title}</b><div className="tiny muted">{d.filename} · version {d.version}{d.ocr_used ? ' · lu par OCR' : ''}{d.embedded ? ' · vecteurs' : ''}</div>
                      {d.flagged && <div className="tiny" style={{ color: 'var(--alert)' }}>Contient des consignes adressées à une IA : traitées comme du texte, jamais suivies.</div>}
                      {d.error && <div className="tiny muted">{d.error}</div>}</td>
                    <td><span className={`badge ${tone}`}>{label}</span></td>
                    <td className="right mono">{d.chunks}</td>
                    <td className="small muted">{ago(d.updated_at)}</td>
                    <td className="right">{admin && <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button className="btn small" onClick={() => { setReplaceId(d.id); replaceRef.current?.click() }}>Nouvelle version</button>
                      <button className="btn small danger" onClick={async () => { if (!window.confirm(`Supprimer « ${d.title} » de la base de connaissances ?`)) return; await api.del(`/api/knowledge/${d.id}`); toast('Document supprimé.'); await load() }}>Supprimer</button>
                    </div>}</td>
                  </tr>
                )
              })}</tbody></table>
          )}
        </div>
        <div className="card card-pad stack">
          <b>Tester une recherche</b>
          <div className="row"><input className="input" placeholder="Ex. délai de relance d'une facture impayée" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search() }} /><button className="btn" onClick={search}>Chercher</button></div>
          {results && results.length === 0 && <span className="small muted">Aucun passage trouvé.</span>}
          {results?.map(r => (
            <div key={r.n} className="stack" style={{ gap: 4, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <span className="small"><b>[{r.n}] {r.title}</b>{r.heading ? ` — ${r.heading}` : ''} <span className="tiny muted">score {r.score}</span></span>
              <span className="small muted">{r.content.slice(0, 400)}{r.content.length > 400 ? '…' : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  )
}
