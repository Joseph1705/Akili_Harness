/**
 * Administration › Clés API et services: the platform operators paste the keys of the services here instead of
 * editing the server's .env file. The server encrypts them, applies them at once and never sends them back (only the
 * last characters, to recognise a key); every change is audited and e-mailed to every operator.
 */
import { useEffect, useState } from 'react'
import { ago, api, ApiError } from '../api'
import { useSession } from '../state'

type Source = 'screen' | 'env' | 'none'
interface Field {
  key: string; label: string; kind: 'secret' | 'text' | 'url' | 'email' | 'int' | 'select'
  help: string | null; placeholder: string | null; options: Array<{ value: string; label: string }> | null
  source: Source; value: string | null; hint: string | null; updatedAt: string | null; updatedBy: string | null
}
interface Section {
  id: string; title: string; description: string; testable: boolean
  status: 'on' | 'off' | 'error'; statusText: string; urls: Array<{ label: string; value: string }>; fields: Field[]
}

const BADGE: Record<Section['status'], [string, string]> = { on: ['green', 'Actif'], off: ['neutral', 'Non configuré'], error: ['reject', 'À corriger'] }
const SOURCE: Record<Source, string> = { screen: 'Saisi ici', env: 'Fichier .env du serveur', none: 'Non réglé' }

export function PlatformSettings() {
  const [sections, setSections] = useState<Section[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.get<{ sections: Section[] }>('/api/platform/settings').then(r => setSections(r.sections)).catch(err => setError(err instanceof ApiError ? err.message : 'Erreur.'))
  }, [])
  const replace = (next: Section) => setSections(list => list?.map(s => s.id === next.id ? next : s) ?? null)
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card card-pad stack" style={{ gap: 6 }}>
        <b>Collez ici les clés de vos services</b>
        <span className="small muted">
          Elles sont chiffrées sur le serveur et prises en compte tout de suite, sans redémarrage. Une clé enregistrée n'est plus jamais
          affichée en entier : ses derniers caractères suffisent à la reconnaître. Une valeur saisie ici remplace celle du fichier .env ;
          « Retirer » revient à la valeur du fichier. Chaque modification est inscrite au journal et signalée par e-mail à tous les administrateurs.
        </span>
        <span className="small muted">
          Restent dans le fichier .env du serveur, car il les faut avant toute connexion : le domaine, le mot de passe de la base,
          la clé maître, l'envoi des e-mails (SMTP) et les adresses des administrateurs.
        </span>
      </div>
      {error && <div className="card card-pad"><span className="error-text">{error}</span></div>}
      {!sections && !error && <span className="spinner" />}
      {sections?.map(s => <SectionCard key={s.id} section={s} onSaved={replace} />)}
    </div>
  )
}

function SectionCard({ section, onSaved }: { section: Section; onSaved: (s: Section) => void }) {
  const { toast } = useSession()
  // A secret field starts empty: left empty, the stored key is kept.
  const initial = () => Object.fromEntries(section.fields.map(f => [f.key, f.kind === 'secret' ? '' : f.value ?? '']))
  const [form, setForm] = useState<Record<string, string>>(initial)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  // After a save, the server's answer is the new state of the section.
  useEffect(() => { setForm(initial()) }, [section])

  const value = (key: string) => (form[key] ?? '').trim()
  const changed = section.fields.filter(f => f.kind === 'secret' ? value(f.key) !== '' : value(f.key) !== (f.value ?? ''))
  const onScreen = section.fields.filter(f => f.source === 'screen')

  async function save(values: Record<string, string | null>, done: string) {
    setBusy(true)
    try {
      const r = await api.put<{ section: Section }>(`/api/platform/settings/${section.id}`, { values })
      setTest(null)
      onSaved(r.section)
      toast(done)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Erreur.', 'err')
    } finally { setBusy(false) }
  }

  async function runTest() {
    setBusy(true)
    setTest(null)
    try {
      setTest(await api.post<{ ok: boolean; message: string }>(`/api/platform/settings/${section.id}/test`))
    } catch (err) {
      setTest({ ok: false, message: err instanceof ApiError ? err.message : 'Erreur.' })
    } finally { setBusy(false) }
  }

  function copy(text: string) {
    // The clipboard needs HTTPS (or localhost): on a first test by IP, select the address by hand.
    navigator.clipboard?.writeText(text).then(() => toast('Adresse copiée.'), () => toast('Copie impossible ici : sélectionnez l’adresse à la main.', 'err'))
  }

  const [tone, label] = BADGE[section.status]
  return (
    <div className="card">
      <div className="card-head"><b>{section.title}</b><span className={`badge ${tone}`}>{label}</span></div>
      <div className="card-pad stack" style={{ gap: 12 }}>
        <span className="small muted">{section.description}</span>
        {/* "Non configuré" alone would only repeat the badge. */}
        {section.statusText !== BADGE.off[1] && <span className={section.status === 'error' ? 'error-text' : 'small'}>{section.statusText}</span>}
        <div className="form-grid">
          {section.fields.map(f => {
            const id = `${section.id}-${f.key}`
            return (
              <div key={f.key} className="field">
                <label htmlFor={id}>{f.label}</label>
                {f.kind === 'select' ? (
                  <select id={id} className="input" value={form[f.key] ?? ''} onChange={e => setForm({ ...form, [f.key]: e.target.value })}>
                    <option value="">{f.placeholder ?? '—'}</option>
                    {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input
                    id={id}
                    className={`input${f.kind === 'secret' || f.kind === 'url' ? ' mono' : ''}`}
                    type={f.kind === 'secret' ? 'password' : f.kind === 'email' ? 'email' : 'text'}
                    inputMode={f.kind === 'int' ? 'numeric' : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={f.kind === 'secret' && f.source !== 'none' ? `Enregistrée${f.hint ? ` (${f.hint})` : ''}` : f.placeholder ?? ''}
                    value={form[f.key] ?? ''}
                    onChange={e => setForm({ ...form, [f.key]: e.target.value })}
                  />
                )}
                <span className="tiny muted row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {SOURCE[f.source]}
                  {f.source === 'screen' && f.updatedAt ? ` · ${ago(f.updatedAt)}${f.updatedBy ? ` par ${f.updatedBy}` : ''}` : ''}
                  {f.source === 'screen' && (
                    <button type="button" className="btn small" style={{ height: 24, padding: '0 8px' }} disabled={busy}
                      onClick={() => save({ [f.key]: null }, `${f.label} : valeur retirée.`)}>Retirer</button>
                  )}
                </span>
                {f.kind === 'secret' && f.source !== 'none' && <span className="tiny muted">Laissez vide pour garder la clé enregistrée ; collez-en une autre pour la remplacer.</span>}
                {f.help && <span className="tiny muted">{f.help}</span>}
              </div>
            )
          })}
        </div>
        {section.urls.map(u => (
          <div key={u.value} className="stack" style={{ gap: 4 }}>
            <span className="tiny muted">{u.label}</span>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="mono small" style={{ wordBreak: 'break-all' }}>{u.value}</span>
              <button type="button" className="btn small" onClick={() => copy(u.value)}>Copier</button>
            </div>
          </div>
        ))}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={busy || changed.length === 0}
            onClick={() => save(Object.fromEntries(changed.map(f => [f.key, value(f.key) === '' ? null : value(f.key)])), `${section.title} : enregistré.`)}>Enregistrer</button>
          {section.testable && (
            <button className="btn" disabled={busy || section.status !== 'on' || changed.length > 0} onClick={runTest}
              title={changed.length > 0 ? "Enregistrez d'abord vos changements." : undefined}>{busy ? <span className="spinner" /> : 'Tester'}</button>
          )}
          {onScreen.length > 1 && (
            <button className="btn danger small" disabled={busy}
              onClick={() => { if (window.confirm(`Retirer toutes les valeurs saisies ici pour « ${section.title} » ?`)) void save(Object.fromEntries(onScreen.map(f => [f.key, null])), `${section.title} : valeurs retirées.`) }}>Tout retirer</button>
          )}
        </div>
        {test && (test.ok ? <div className="callout">{test.message}</div> : <span className="error-text">{test.message}</span>)}
      </div>
    </div>
  )
}
