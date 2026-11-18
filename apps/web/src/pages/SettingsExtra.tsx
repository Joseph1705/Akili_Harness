/** Settings tabs for AI, connectors and MCP tools (administrators change them; everyone sees their state). */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, ago, uuid } from '../api'
import { can, useSession } from '../state'

function useRun() {
  const { toast } = useSession()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await fn(); if (ok) toast(ok) } catch (err) { toast(err instanceof ApiError ? err.message : 'Erreur.', 'err') } finally { setBusy(false) }
  }
  return { busy, run }
}

// ------------------------------------------------------------ AI

interface AiStatus {
  access: { allowed: boolean; reason: string | null; order: string[] }
  settings: { enabled: boolean; mode: 'external' | 'local'; use_for_extraction: boolean; use_for_chat: boolean; whatsapp_drafts: boolean; monthly_token_limit: number | null }
  externalConsent: boolean
  providers: { anthropic: { light: string; heavy: string } | null; deepseek: { light: string; heavy: string } | null; local: { light: string; heavy: string } | null; embeddings: { model: string; external: boolean } | null }
}

export function AiSettings() {
  const { me } = useSession()
  const admin = can.configure(me?.org?.role)
  const [s, setS] = useState<AiStatus | null>(null)
  const [form, setForm] = useState<AiStatus['settings'] | null>(null)
  const { busy, run } = useRun()
  const load = useCallback(() => api.get<AiStatus>('/api/ai/status').then(r => { setS(r); setForm(r.settings) }), [])
  useEffect(() => { void load() }, [load])
  if (!s || !form) return <div className="empty"><span className="spinner" /></div>
  const p = s.providers
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card card-pad stack">
        <div className="spread"><b>Intelligence artificielle</b><span className={`badge ${s.access.allowed ? 'green' : 'neutral'}`}>{s.access.allowed ? 'Active' : 'Inactive'}</span></div>
        {!s.access.allowed && s.access.reason && <span className="small muted">{s.access.reason}</span>}
        <span className="small muted">Sans IA, tout fonctionne : les documents sont lus sur ce serveur (OCR et lecture locale) et les commandes de l'assistant répondent. L'IA ajoute la lecture plus fine des documents, les questions libres et l'usage des outils.</span>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" disabled={!admin} checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Activer l'IA pour l'organisation</label>
        <div className="field"><label>Où les modèles s'exécutent</label>
          <div className="segmented">
            <button type="button" disabled={!admin} aria-pressed={form.mode === 'external'} onClick={() => setForm({ ...form, mode: 'external' })}>Fournisseur externe (données pseudonymisées)</button>
            <button type="button" disabled={!admin} aria-pressed={form.mode === 'local'} onClick={() => setForm({ ...form, mode: 'local' })}>Modèle local uniquement</button>
          </div>
          <span className="hint">{form.mode === 'external'
            ? (s.externalConsent ? 'Consentement donné : les noms, NIF, e-mails et numéros sont remplacés par des jetons avant envoi.' : <>Nécessite le consentement « fournisseur externe » (<Link to="/parametres?onglet=data">Données et consentements</Link>).</>)
            : (p.local ? 'Aucune donnée ne quitte nos serveurs.' : "Aucun modèle local n'est installé sur ce serveur.")}</span>
        </div>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" disabled={!admin} checked={form.use_for_extraction} onChange={e => setForm({ ...form, use_for_extraction: e.target.checked })} /> Lire les documents avec l'IA (toujours vérifiés par une personne)</label>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" disabled={!admin} checked={form.use_for_chat} onChange={e => setForm({ ...form, use_for_chat: e.target.checked })} /> Questions libres à l'assistant</label>
        <label className="small row" style={{ gap: 6 }}><input type="checkbox" disabled={!admin} checked={form.whatsapp_drafts} onChange={e => setForm({ ...form, whatsapp_drafts: e.target.checked })} /> Brouillons de réponse WhatsApp (envoyés seulement après validation)</label>
        <div className="field"><label>Plafond mensuel (jetons, facultatif)</label><input className="input mono" inputMode="numeric" disabled={!admin} value={form.monthly_token_limit ?? ''} onChange={e => setForm({ ...form, monthly_token_limit: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null })} placeholder="Sans plafond" /><span className="hint">Sécurité contre un emballement ; vos documents restent facturés au crédit, pas au jeton.</span></div>
        {admin && <div><button className="btn primary" disabled={busy} onClick={() => run(async () => { await api.put('/api/ai/settings', form); await load() }, 'Réglages enregistrés.')}>Enregistrer</button></div>}
      </div>
      <div className="card card-pad stack small">
        <b>Modèles disponibles sur ce serveur</b>
        <span>Claude (Anthropic) : {p.anthropic ? `${p.anthropic.light} pour les tâches simples, ${p.anthropic.heavy} pour les tâches complexes` : 'non configuré'}</span>
        <span>DeepSeek : {p.deepseek ? `${p.deepseek.light} / ${p.deepseek.heavy}` : 'non configuré'}</span>
        <span>Modèle local : {p.local ? `${p.local.light} / ${p.local.heavy}` : 'non installé'}</span>
        <span>Recherche par le sens (embeddings) : {p.embeddings ? `${p.embeddings.model}${p.embeddings.external ? ' (externe)' : ' (local)'}` : 'non configurée'}</span>
        <span className="muted">Ordre utilisé pour votre organisation : {s.access.order.join(' → ') || '—'}. Si un modèle ne répond pas, le suivant prend le relais.</span>
        {admin && <Link to="/activite-ia">Voir l'activité de l'IA</Link>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ connectors

interface Connectors {
  google: { available: boolean; connection: { status: string; account: string | null; services: string[]; last_error: string | null; updated_at: string } | null; services: Array<{ id: string; label: string; available: boolean }> }
  whatsapp: { available: boolean; webhook: string; connection: { status: string; account: string | null; last_error: string | null; updated_at: string } | null }
}

export function ConnectorSettings() {
  const { me, toast } = useSession()
  const admin = can.configure(me?.org?.role)
  const [c, setC] = useState<Connectors | null>(null)
  const [services, setServices] = useState<string[]>(['gmail_read', 'gmail_send', 'sheets'])
  const [wa, setWa] = useState({ phone_number_id: '', access_token: '' })
  const [sheet, setSheet] = useState({ spreadsheet_id: '', range: 'Factures!A1' })
  const { busy, run } = useRun()
  const load = useCallback(() => api.get<Connectors>('/api/connectors').then(setC), [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('google') === 'ok') toast('Google est connecté.')
    else if (q.get('google') === 'erreur') toast(q.get('raison') ?? 'Connexion Google impossible.', 'err')
  }, [toast])
  if (!c) return <div className="empty"><span className="spinner" /></div>
  const g = c.google.connection
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card card-pad stack">
        <div className="spread"><b>Google (Gmail, Sheets)</b><span className={`badge ${g?.status === 'connected' ? 'green' : g ? 'reject' : 'neutral'}`}>{g?.status === 'connected' ? `Connecté · ${g.account}` : g ? 'À reconnecter' : 'Non connecté'}</span></div>
        {!c.google.available && <span className="small muted">La connexion Google n'est pas encore configurée sur ce serveur (identifiants OAuth de l'application).</span>}
        {g?.last_error && <span className="small" style={{ color: 'var(--reject)' }}>{g.last_error}</span>}
        {c.google.available && admin && (<>
          <span className="small muted">Vous serez redirigé vers Google pour autoriser l'accès. Les jetons sont chiffrés ; l'envoi d'e-mails et l'écriture dans Sheets se font toujours sur action ou validation d'une personne.</span>
          {c.google.services.map(s => (
            <label key={s.id} className="small row" style={{ gap: 6 }}><input type="checkbox" disabled={!s.available} checked={services.includes(s.id)} onChange={e => setServices(e.target.checked ? [...services, s.id] : services.filter(x => x !== s.id))} /> {s.label}</label>
          ))}
          <div className="row">
            <button className="btn primary" disabled={busy || services.length === 0} onClick={() => run(async () => { const r = await api.post<{ url: string }>('/api/connectors/google/start', { services }); window.location.assign(r.url) })}>{g ? 'Reconnecter Google' : 'Connecter Google'}</button>
            {g && <button className="btn danger" disabled={busy} onClick={() => run(async () => { await api.del('/api/connectors/google'); await load() }, 'Google déconnecté et autorisation retirée.')}>Déconnecter</button>}
          </div>
        </>)}
        {g?.status === 'connected' && g.services.includes('sheets') && can.validate(me?.org?.role) && (
          <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <b className="small">Exporter les factures validées vers Google Sheets</b>
            <div className="row"><input className="input mono" placeholder="Identifiant de la feuille (dans son adresse)" value={sheet.spreadsheet_id} onChange={e => setSheet({ ...sheet, spreadsheet_id: e.target.value.trim() })} /><input className="input mono" style={{ maxWidth: 160 }} value={sheet.range} onChange={e => setSheet({ ...sheet, range: e.target.value })} aria-label="Plage" /></div>
            <div><button className="btn small" disabled={busy || !sheet.spreadsheet_id} onClick={() => run(async () => { const r = await api.post<{ rows: number }>('/api/connectors/google/sheets/invoices', sheet, { 'idempotency-key': uuid() }); toast(`${r.rows} facture(s) exportée(s).`) })}>Exporter</button></div>
          </div>
        )}
      </div>
      <div className="card card-pad stack">
        <div className="spread"><b>WhatsApp Business</b><span className={`badge ${c.whatsapp.connection?.status === 'connected' ? 'green' : 'neutral'}`}>{c.whatsapp.connection?.status === 'connected' ? `Connecté · ${c.whatsapp.connection.account}` : 'Non connecté'}</span></div>
        {!c.whatsapp.available && <span className="small muted">WhatsApp n'est pas encore configuré sur ce serveur (application Meta de la plateforme).</span>}
        {c.whatsapp.available && (<>
          <span className="small muted">Plateforme officielle WhatsApp Business (API Cloud de Meta). Dans Meta Business Manager, copiez l'identifiant du numéro et un jeton d'accès permanent. Adresse de webhook à déclarer : <span className="mono">{c.whatsapp.webhook}</span></span>
          {admin && (<>
            <div className="form-grid">
              <div className="field"><label>Identifiant du numéro (phone number ID)</label><input className="input mono" value={wa.phone_number_id} onChange={e => setWa({ ...wa, phone_number_id: e.target.value.trim() })} /></div>
              <div className="field"><label>Jeton d'accès</label><input className="input mono" type="password" autoComplete="off" value={wa.access_token} onChange={e => setWa({ ...wa, access_token: e.target.value.trim() })} /></div>
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy || !wa.phone_number_id || !wa.access_token} onClick={() => run(async () => { await api.post('/api/connectors/whatsapp', wa); setWa({ phone_number_id: '', access_token: '' }); await load() }, 'WhatsApp connecté (vérifié auprès de Meta).')}>Vérifier et connecter</button>
              {c.whatsapp.connection && <button className="btn danger" disabled={busy} onClick={() => run(async () => { await api.del('/api/connectors/whatsapp'); await load() }, 'WhatsApp déconnecté.')}>Déconnecter</button>}
            </div>
          </>)}
          {c.whatsapp.connection && <Link className="small" to="/whatsapp">Ouvrir les conversations</Link>}
        </>)}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ MCP

interface McpServer { id: string; name: string; url: string; status: string; last_error: string | null; last_discovered_at: string | null; has_token: boolean }
interface McpTool { id: string; server_id: string; name: string; description: string | null; enabled: boolean; permission: string; requires_approval: boolean }
const PERM: Record<string, string> = { read: 'Tous les membres', operate: 'Opérateurs et plus', validate: 'Validateurs et plus', configure: 'Administrateurs' }

export function McpSettings() {
  const { me, toast } = useSession()
  const admin = can.configure(me?.org?.role)
  const [data, setData] = useState<{ servers: McpServer[]; tools: McpTool[] } | null>(null)
  const [f, setF] = useState({ name: '', url: '', token: '' })
  const { busy, run } = useRun()
  const load = useCallback(() => api.get<{ servers: McpServer[]; tools: McpTool[] }>('/api/mcp').then(setData), [])
  useEffect(() => { if (admin) void load() }, [load, admin])
  if (!admin) return <p className="muted">Seuls les administrateurs gèrent les outils MCP.</p>
  if (!data) return <div className="empty"><span className="spinner" /></div>
  const update = (t: McpTool, patch: Partial<McpTool>) => run(async () => { await api.patch(`/api/mcp/tools/${t.id}`, { enabled: t.enabled, permission: t.permission, requires_approval: t.requires_approval, ...patch }); await load() })
  return (
    <div className="stack" style={{ maxWidth: 980 }}>
      <p className="muted" style={{ margin: 0 }}>Un serveur MCP donne des outils aux agents (CRM, ERP, banque…). Ses outils sont désactivés à l'ajout : activez ceux dont vous avez besoin, choisissez qui peut s'en servir et s'ils demandent une validation à chaque appel. Adresses https publiques uniquement.</p>
      <div className="card card-pad stack">
        <b>Ajouter un serveur</b>
        <div className="form-grid">
          <div className="field"><label>Nom</label><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label>Adresse (https://…)</label><input className="input mono" value={f.url} onChange={e => setF({ ...f, url: e.target.value.trim() })} /></div>
          <div className="field full"><label>Jeton d'accès (facultatif, chiffré)</label><input className="input mono" type="password" autoComplete="off" value={f.token} onChange={e => setF({ ...f, token: e.target.value })} /></div>
        </div>
        <div><button className="btn primary" disabled={busy || f.name.trim().length < 2 || !f.url} onClick={() => run(async () => {
          const r = await api.post<{ tools: number; error: string | null }>('/api/mcp', { name: f.name.trim(), url: f.url, token: f.token || undefined })
          if (r.error) toast(r.error, 'err'); else toast(`${r.tools} outil(s) découvert(s), désactivés pour l'instant.`)
          setF({ name: '', url: '', token: '' }); await load()
        })}>Ajouter et découvrir les outils</button></div>
      </div>
      {data.servers.map(s => (
        <div className="card" key={s.id}>
          <div className="card-head"><div><b>{s.name}</b> <span className="small muted mono">{s.url}</span>{s.last_error && <div className="tiny" style={{ color: 'var(--reject)' }}>{s.last_error}</div>}</div>
            <div className="row"><span className={`badge ${s.status === 'ok' ? 'green' : s.status === 'error' ? 'reject' : 'neutral'}`}>{s.status === 'ok' ? `OK · ${s.last_discovered_at ? ago(s.last_discovered_at) : ''}` : s.status}</span>
              <button className="btn small" disabled={busy} onClick={() => run(async () => { await api.post(`/api/mcp/${s.id}/discover`); await load() }, 'Outils mis à jour.')}>Actualiser</button>
              <button className="btn small danger" disabled={busy} onClick={() => { if (window.confirm(`Supprimer le serveur « ${s.name} » ?`)) void run(async () => { await api.del(`/api/mcp/${s.id}`); await load() }, 'Serveur supprimé.') }}>Supprimer</button></div></div>
          <table className="table"><thead><tr><th>Outil</th><th>Actif</th><th>Qui peut l'utiliser</th><th>Validation à chaque appel</th></tr></thead>
            <tbody>{data.tools.filter(t => t.server_id === s.id).map(t => (
              <tr key={t.id}><td><b className="mono small">{t.name}</b><div className="tiny muted">{t.description}</div></td>
                <td><input type="checkbox" aria-label={`Activer ${t.name}`} checked={t.enabled} disabled={busy} onChange={e => update(t, { enabled: e.target.checked })} /></td>
                <td><select className="input" value={t.permission} disabled={busy} onChange={e => update(t, { permission: e.target.value })}>{Object.entries(PERM).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                <td><input type="checkbox" aria-label={`Validation pour ${t.name}`} checked={t.requires_approval} disabled={busy} onChange={e => update(t, { requires_approval: e.target.checked })} /></td></tr>
            ))}</tbody></table>
        </div>
      ))}
    </div>
  )
}
