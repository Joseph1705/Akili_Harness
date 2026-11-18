/**
 * Review of a document before it becomes an invoice (DIRECTIVES §4 steps 5–8): what was read, the proposed
 * invoice to correct, the checks, then "Générer la facture" — the moment the one credit is used.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, download, money, uuid } from '../api'
import { InvoiceForm, toPayload, type Check, type ClientOption, type InvoiceInput } from '../components/InvoiceForm'
import { Shell } from '../components/Shell'
import { Icon } from '../icons'
import { can, useSession } from '../state'

interface Doc {
  id: string; filename: string; kind: string; status: string; error: string | null; invoice_id: string | null; invoice_number: string | null
  ocr_used: boolean; ocr_confidence: number | null; pages: number | null; extraction_method: string | null; created_at: string
}
interface Review {
  extracted: { document_type: string; reference: string | null; total: string | null; currency: string | null; client: { name: string | null }; suspicious_instructions: boolean; lines: unknown[] }
  suggestion: InvoiceInput; matchedClient: { id: string; name: string } | null; checks: Check[]
  possibleDuplicate: { filename: string; invoice_number: string | null } | null; balance: number
}

const TYPE: Record<string, string> = { invoice: 'Facture', quote: 'Devis', purchase_order: 'Bon de commande', delivery_note: 'Bon de livraison', receipt: 'Reçu', statement: 'Relevé', other: 'Document' }
const STATUS: Record<string, string> = { queued: 'en file', processing: 'en lecture', waiting_credits: 'en attente de crédits', needs_review: 'à vérifier', done: 'facture créée', duplicate: 'doublon', failed: 'échec', dismissed: 'écarté' }

export function DocumentReview() {
  const { id } = useParams()
  const { me, toast } = useSession()
  const navigate = useNavigate()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [form, setForm] = useState<InvoiceInput | null>(null)
  const [clients, setClients] = useState<ClientOption[]>([])
  const [busy, setBusy] = useState(false)
  const [noCredit, setNoCredit] = useState<number | null>(null)
  const [key] = useState(uuid)
  const draftKey = `revue:${id}`

  const load = useCallback(async () => {
    const r = await api.get<{ document: Doc; review: Review | null }>(`/api/documents/${id}`)
    setDoc(r.document)
    setReview(r.review)
    if (r.review) {
      // A form left half-filled (network cut, tab closed) comes back as it was.
      let saved: InvoiceInput | null = null
      try { const raw = localStorage.getItem(draftKey); saved = raw ? JSON.parse(raw) as InvoiceInput : null } catch { saved = null }
      setForm(saved ?? r.review.suggestion)
    }
  }, [id, draftKey])
  useEffect(() => { void load().catch(() => setDoc(null)); api.get<{ clients: ClientOption[] }>('/api/clients').then(r => setClients(r.clients)).catch(() => undefined) }, [load])
  useEffect(() => {
    if (!doc || !['queued', 'processing'].includes(doc.status)) return
    const t = window.setInterval(() => void load(), 1500)
    return () => window.clearInterval(t)
  }, [doc, load])
  useEffect(() => { if (form) { try { localStorage.setItem(draftKey, JSON.stringify(form)) } catch { /* private mode */ } } }, [form, draftKey])

  async function generate() {
    if (!form) return
    setBusy(true)
    try {
      const r = await api.post<{ invoice: { id: string; number: string }; balance: number }>(`/api/documents/${id}/invoice`, toPayload(form), { 'idempotency-key': key })
      try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
      toast(`Projet de facture ${r.invoice.number} créé. Il vous reste ${r.balance} crédit${r.balance > 1 ? 's' : ''}.`)
      navigate(`/validations/${r.invoice.id}`)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'insufficient_credits') setNoCredit(Number(err.body?.balance ?? 0))
      else toast(err instanceof ApiError ? err.message : 'Erreur.', 'err')
    } finally { setBusy(false) }
  }

  async function act(path: 'dismiss' | 'reprocess', done: string) {
    setBusy(true)
    try { await api.post(`/api/documents/${id}/${path}`, {}); toast(done); try { localStorage.removeItem(draftKey) } catch { /* ignore */ } await load() }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }

  if (!doc) return <Shell crumb="Documents" title="Document"><div className="page empty"><span className="spinner" /></div></Shell>
  const operator = can.operate(me?.org?.role)
  return (
    <Shell crumb="Documents › Vérification" title={doc.filename}>
      <div className="page stack" style={{ gap: 16, maxWidth: 1180 }}>
        <div className="card card-pad spread" style={{ alignItems: 'flex-start' }}>
          <div className="kv">
            <span>État</span><span><b>{STATUS[doc.status] ?? doc.status}</b>{doc.error ? ` — ${doc.error}` : ''}</span>
            <span>Type lu</span><span>{review ? TYPE[review.extracted.document_type] : '—'}{review?.extracted.reference ? ` n° ${review.extracted.reference}` : ''}</span>
            <span>Lecture</span><span>{doc.ocr_used ? `scan ou photo lu par OCR (confiance ${doc.ocr_confidence ?? '?'} %)` : 'texte du document'}{doc.extraction_method?.startsWith('ai:') ? ' · champs proposés par l\'IA' : doc.extraction_method === 'local' ? ' · lecture locale, sans IA' : ''}</span>
            {review?.extracted.total && <><span>Total lu</span><span className="mono">{review.extracted.total.replace('.', ',')} {review.extracted.currency ?? ''}</span></>}
          </div>
          <div className="row">
            <button className="btn small" onClick={() => download(`/api/documents/${doc.id}/file`, doc.filename)}><Icon name="download" size={14} /> Document original</button>
            {doc.invoice_id && <Link className="btn small primary" to={`/validations/${doc.invoice_id}`}>Voir la facture {doc.invoice_number}</Link>}
          </div>
        </div>

        {review?.extracted.suspicious_instructions && (
          <div className="callout"><Icon name="alert" size={16} /><span><b>Consignes suspectes ignorées.</b> Ce document contient des instructions adressées à l'IA. Elles n'ont aucun effet : seules les valeurs que vous validez comptent.</span></div>
        )}
        {review?.possibleDuplicate && (
          <div className="callout"><Icon name="alert" size={16} /><span><b>Peut-être déjà facturé.</b> Le même numéro de document figure dans « {review.possibleDuplicate.filename} »{review.possibleDuplicate.invoice_number ? ` (facture ${review.possibleDuplicate.invoice_number})` : ''}. Vérifiez avant de générer.</span></div>
        )}
        {noCredit !== null && (
          <div className="callout" role="alert"><Icon name="coin" size={16} /><span><b>Crédits insuffisants (solde : {noCredit}).</b> Générer cette facture utilise 1 crédit. Achetez des crédits, puis revenez : vos corrections sont conservées. <Link to="/credits">Acheter des crédits</Link></span></div>
        )}

        {doc.status === 'needs_review' && form && (<>
          <InvoiceForm value={form} onChange={setForm} clients={clients} checks={review?.checks} disabled={!operator} />
          {operator ? (
            <div className="card card-pad spread">
              <span className="small muted">Solde : {review?.balance ?? '–'} crédit{(review?.balance ?? 0) > 1 ? 's' : ''}. Générer crée un projet de facture (à valider ensuite) et utilise 1 crédit. Un échec ne coûte rien.</span>
              <div className="row">
                <button className="btn" disabled={busy} onClick={() => setForm(review!.suggestion)}>Revenir à la lecture</button>
                <button className="btn danger" disabled={busy} onClick={() => act('dismiss', 'Document écarté. Aucun crédit utilisé.')}>Écarter</button>
                <button className="btn primary" disabled={busy || !form.lines.length} onClick={generate}>{busy ? <span className="spinner" /> : <><Icon name="check" size={16} /> Générer la facture (1 crédit)</>}</button>
              </div>
            </div>
          ) : <p className="small muted">Votre rôle permet de consulter ce document, pas de générer la facture.</p>}
        </>)}

        {doc.status === 'failed' && operator && (
          <div className="card card-pad spread">
            <span className="small">La lecture a échoué sans utiliser de crédit. Vous pouvez relire le document (après avoir ajouté un contrat, activé l'IA…) ou saisir la facture à la main.</span>
            <div className="row"><button className="btn" disabled={busy} onClick={() => act('reprocess', 'Le document va être relu.')}>Relire</button><Link className="btn primary" to="/factures/nouvelle">Saisir à la main</Link></div>
          </div>
        )}
        {doc.status === 'waiting_credits' && <div className="callout"><Icon name="coin" size={16} /><span>Ce document attend des crédits : il sera lu dès l'achat. <Link to="/credits">Acheter des crédits</Link></span></div>}
        {review && <p className="tiny muted">Montants recalculés par l'application ; total lu : {review.extracted.total ? money(Math.round(Number(review.extracted.total) * 100), review.extracted.currency ?? '') : 'non lu'}.</p>}
      </div>
    </Shell>
  )
}
