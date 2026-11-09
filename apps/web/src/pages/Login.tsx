/** Login by e-mail code (directive 5.1). */
import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'
import { useSession } from '../state'

export function Login() {
  const { refresh, config } = useSession()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function requestCode(e: FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      await api.post('/api/auth/request-code', { email })
      setStep('code')
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Erreur.') } finally { setBusy(false) }
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      await api.post('/api/auth/verify', { email, code })
      await refresh()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Erreur.') } finally { setBusy(false) }
  }

  return (
    <div className="center-page motif">
      <div className="auth-card stack" style={{ gap: 18 }}>
        <div className="auth-logo">
          <img className="light-only" src="/brand/totem.png" alt="" />
          <img className="dark-only" src="/brand/tete-ivoire.png" alt="" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div className="eyebrow">{config?.brand ?? 'Akili'} · Agents IA souverains</div>
          <h1 style={{ marginTop: 6 }}>Vos données restent chez vous.</h1>
        </div>
        {step === 'email' ? (
          <form className="stack" onSubmit={requestCode}>
            <div className="field">
              <label htmlFor="email">Adresse e-mail professionnelle</label>
              <input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="prenom.nom@entreprise.cd" autoFocus />
            </div>
            {error && <div className="error-text" role="alert">{error}</div>}
            <button className="btn primary block" disabled={busy}>{busy ? <span className="spinner" /> : 'Recevoir un code de connexion'}</button>
            <p className="hint" style={{ margin: 0, textAlign: 'center' }}>Pas de mot de passe : nous vous envoyons un code à 6 chiffres, valable 10 minutes.</p>
          </form>
        ) : (
          <form className="stack" onSubmit={verify}>
            <p style={{ margin: 0 }}>Code envoyé à <b>{email}</b>. Pensez à regarder dans les courriers indésirables.</p>
            <div className="field">
              <label htmlFor="code">Code à 6 chiffres</label>
              <input id="code" className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoFocus style={{ letterSpacing: '.4em', fontSize: 20, height: 48 }} />
            </div>
            {error && <div className="error-text" role="alert">{error}</div>}
            <button className="btn primary block" disabled={busy || code.length !== 6}>{busy ? <span className="spinner" /> : 'Se connecter'}</button>
            <button type="button" className="btn ghost block" onClick={() => { setStep('email'); setCode(''); setError('') }}>Changer d'adresse ou renvoyer un code</button>
          </form>
        )}
        <div className="hint" style={{ textAlign: 'center' }}>{config?.hostingLabel}</div>
      </div>
    </div>
  )
}
