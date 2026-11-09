/** Onboarding (directive 5.2): short, saved at each step, optional fields can be skipped. */
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api'
import { useSession } from '../state'

type Step = 'type' | 'profile' | 'company' | 'tax' | 'tools' | 'data' | 'team' | 'done'

export function Onboarding() {
  const { me, refresh, toast, config, bumpLogo } = useSession()
  const org = me?.org
  const individual = org?.kind === 'individual'
  const steps: Step[] = individual ? ['type', 'profile', 'tools', 'data', 'done'] : ['type', 'profile', 'company', 'tax', 'tools', 'data', 'team', 'done']
  const [step, setStep] = useState<Step>(org ? 'profile' : 'type')
  const [form, setForm] = useState<Record<string, string>>({})
  const [kind, setKind] = useState<'company' | 'individual'>('company')
  const [consents, setConsents] = useState({ terms: false, privacy: false, external_model: false })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!me) return
    setForm(f => ({
      first_name: me.user.first_name ?? '', last_name: me.user.last_name ?? '', phone: me.user.phone ?? '',
      name: org?.name ?? '', sector: org?.sector ?? '', city: org?.city ?? 'Lubumbashi', province: org?.province ?? 'Haut-Katanga',
      currency: org?.currency ?? 'USD', team_size: org?.team_size ?? '', rccm: org?.rccm ?? '', id_nat: org?.id_nat ?? '', nif: org?.nif ?? '',
      address: org?.address ?? '', vat_status: org?.vat_status ?? 'unknown', accounting_software: org?.accounting_software ?? '',
      reports_channel: org?.reports_channel ?? '', data_mode: org?.data_mode ?? 'standard', ...f,
    }))
  }, [me, org])

  const set = (k: string) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }))
  const index = steps.indexOf(step)
  const next = () => setStep(steps[Math.min(index + 1, steps.length - 1)]!)
  const back = () => setStep(steps[Math.max(index - 1, 0)]!)
  const nn = (v: string | undefined) => (v && v.trim() ? v.trim() : null)

  async function run(fn: () => Promise<void>) {
    setError(''); setBusy(true)
    try { await fn() } catch (err) { setError(err instanceof ApiError ? err.message : 'Erreur.') } finally { setBusy(false) }
  }

  const save = () => run(async () => {
    if (step === 'type') {
      await api.post('/api/orgs', kind === 'company' ? { kind, name: form.name } : { kind })
      await refresh()
    } else if (step === 'profile') {
      await api.patch('/api/me/profile', { first_name: form.first_name, last_name: form.last_name, phone: nn(form.phone), locale: 'fr' })
    } else if (step === 'company') {
      await api.patch('/api/orgs/current', { name: form.name, sector: nn(form.sector), city: nn(form.city), province: nn(form.province), currency: form.currency, team_size: nn(form.team_size), onboarding_step: 4 })
    } else if (step === 'tax') {
      await api.patch('/api/orgs/current', { rccm: nn(form.rccm), id_nat: nn(form.id_nat), nif: nn(form.nif), address: nn(form.address), vat_status: form.vat_status, onboarding_step: 5 })
    } else if (step === 'tools') {
      await api.patch('/api/orgs/current', { accounting_software: nn(form.accounting_software), reports_channel: nn(form.reports_channel), onboarding_step: 6 })
    } else if (step === 'data') {
      if (!consents.terms || !consents.privacy) throw new ApiError(400, 'consent', "Acceptez les conditions d'utilisation et la politique de confidentialité pour continuer.")
      await api.patch('/api/orgs/current', { data_mode: form.data_mode, onboarding_step: 7 })
      await api.post('/api/orgs/current/consents', { type: 'terms', granted: true })
      await api.post('/api/orgs/current/consents', { type: 'privacy', granted: true })
      await api.post('/api/orgs/current/consents', { type: 'external_model', granted: consents.external_model })
    } else if (step === 'team') {
      if (form.invite_email) await api.post('/api/orgs/current/members', { email: form.invite_email, role: form.invite_role || 'operator' })
    }
    next()
  })

  const finish = (withDemo: boolean) => run(async () => {
    if (withDemo) {
      await api.post('/api/demo/load')
      await api.post('/api/credits/topup', { credits: 25, ref: 'DEMO-OFFERT' })
      await api.post('/api/agents', { packId: 'facturation-sous-traitance', name: 'Agent Facturation' })
    }
    await api.post('/api/orgs/current/onboarding/complete')
    await refresh()
    toast('Votre espace est prêt.')
  })

  async function uploadLogo(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    await run(async () => { await api.post('/api/orgs/current/logo', fd); bumpLogo(); toast('Logo enregistré.') })
  }

  return (
    <div className="center-page motif">
      <div className="onb card card-pad stack" style={{ gap: 18, padding: 32 }}>
        <div className="spread">
          <div className="row"><img src="/brand/tete-vert-128.png" width={32} height={32} alt="" /><b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{config?.brand}</b></div>
          <span className="muted small">Étape {index + 1} sur {steps.length}</span>
        </div>
        <div className="onb-steps">{steps.map((s, i) => <span key={s} className={i <= index ? 'on' : ''} />)}</div>

        {step === 'type' && (<>
          <h1>Bienvenue. Qui êtes-vous ?</h1>
          <div className="choice-grid">
            <button type="button" className={`choice${kind === 'company' ? ' on' : ''}`} onClick={() => setKind('company')}>
              <b>Je suis une entreprise</b><span className="small muted">Offre Entreprise · agents sur Claude Opus 5.5</span>
            </button>
            <button type="button" className={`choice${kind === 'individual' ? ' on' : ''}`} onClick={() => setKind('individual')}>
              <b>Je suis un indépendant ou un particulier</b><span className="small muted">Offre Entrepreneur individuel · agents sur DeepSeek</span>
            </button>
          </div>
          {kind === 'company' && <div className="field"><label htmlFor="name">Nom de l'entreprise (raison sociale)</label><input id="name" className="input" value={form.name ?? ''} onChange={set('name')} placeholder="Kibala Services SARL" /></div>}
        </>)}

        {step === 'profile' && (<>
          <h1>Votre profil</h1>
          <div className="form-grid">
            <div className="field"><label>Prénom</label><input className="input" value={form.first_name ?? ''} onChange={set('first_name')} required /></div>
            <div className="field"><label>Nom</label><input className="input" value={form.last_name ?? ''} onChange={set('last_name')} required /></div>
            <div className="field"><label>Téléphone <span className="muted">(facultatif)</span></label><input className="input" value={form.phone ?? ''} onChange={set('phone')} placeholder="+243 …" /></div>
            <div className="field"><label>Langue</label><select className="input" disabled><option>Français</option></select><span className="hint">L'anglais arrive bientôt.</span></div>
          </div>
        </>)}

        {step === 'company' && (<>
          <h1>Votre entreprise</h1>
          <div className="form-grid">
            <div className="field full"><label>Nom de l'entreprise</label><input className="input" value={form.name ?? ''} onChange={set('name')} /></div>
            <div className="field"><label>Secteur</label><input className="input" value={form.sector ?? ''} onChange={set('sector')} placeholder="Sous-traitance minière" /></div>
            <div className="field"><label>Taille de l'équipe</label><select className="input" value={form.team_size ?? ''} onChange={set('team_size')}><option value="">—</option><option>1-5</option><option>6-20</option><option>21-50</option><option>51-200</option><option>200+</option></select></div>
            <div className="field"><label>Ville</label><input className="input" value={form.city ?? ''} onChange={set('city')} /></div>
            <div className="field"><label>Province</label><input className="input" value={form.province ?? ''} onChange={set('province')} /></div>
            <div className="field"><label>Devise principale</label><select className="input" value={form.currency} onChange={set('currency')}><option value="USD">USD</option><option value="CDF">CDF</option></select></div>
            <div className="field"><label>Logo <span className="muted">(PNG, JPG ou WebP, 2 Mo max.)</span></label>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={e => e.target.files?.[0] && uploadLogo(e.target.files[0])} />
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>{org?.has_logo ? 'Remplacer le logo' : 'Choisir un fichier'}</button>
            </div>
          </div>
        </>)}

        {step === 'tax' && (<>
          <h1>Identité légale et fiscale</h1>
          <p className="muted" style={{ margin: 0 }}>Facultatif maintenant, requis avant l'émission de tout document officiel.</p>
          <div className="form-grid">
            <div className="field"><label>RCCM</label><input className="input mono" value={form.rccm ?? ''} onChange={set('rccm')} placeholder="CD/LSH/RCCM/…" /></div>
            <div className="field"><label>Id. Nat.</label><input className="input mono" value={form.id_nat ?? ''} onChange={set('id_nat')} /></div>
            <div className="field"><label>NIF (numéro d'impôt)</label><input className="input mono" value={form.nif ?? ''} onChange={set('nif')} /></div>
            <div className="field"><label>Assujetti à la TVA</label><select className="input" value={form.vat_status} onChange={set('vat_status')}><option value="yes">Oui</option><option value="no">Non</option><option value="unknown">Je ne sais pas</option></select></div>
            <div className="field full"><label>Adresse</label><input className="input" value={form.address ?? ''} onChange={set('address')} /></div>
          </div>
        </>)}

        {step === 'tools' && (<>
          <h1>Vos outils actuels</h1>
          <div className="form-grid">
            <div className="field"><label>Logiciel comptable</label><select className="input" value={form.accounting_software ?? ''} onChange={set('accounting_software')}><option value="">—</option><option>Banana Accounting</option><option>Autre</option><option>Aucun</option></select></div>
            <div className="field"><label>Comment arrivent vos rapports ?</label><select className="input" value={form.reports_channel ?? ''} onChange={set('reports_channel')}><option value="">—</option><option>E-mail</option><option>WhatsApp</option><option>Dossier partagé</option><option>Papier</option></select></div>
          </div>
        </>)}

        {step === 'data' && (<>
          <h1>Vos données et vos consentements</h1>
          <div className="choice-grid">
            <button type="button" className={`choice${form.data_mode === 'standard' ? ' on' : ''}`} onClick={() => setForm(f => ({ ...f, data_mode: 'standard' }))}>
              <b>Standard</b><span className="small muted">Vos fichiers sont stockés et chiffrés sur notre serveur. Les questions libres à l'assistant passent par un modèle externe, seulement si vous l'autorisez ci-dessous.</span>
            </button>
            <button type="button" className={`choice${form.data_mode === 'souverain' ? ' on' : ''}`} onClick={() => setForm(f => ({ ...f, data_mode: 'souverain' }))}>
              <b>Souverain</b><span className="small muted">Un modèle installé chez vous ; rien ne sort de vos locaux. Installation par notre équipe.</span>
            </button>
          </div>
          <label className="check-row"><input type="checkbox" checked={consents.terms} onChange={e => setConsents(c => ({ ...c, terms: e.target.checked }))} /> J'accepte les conditions d'utilisation.</label>
          <label className="check-row"><input type="checkbox" checked={consents.privacy} onChange={e => setConsents(c => ({ ...c, privacy: e.target.checked }))} /> J'accepte la politique de confidentialité.</label>
          <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
            <label className="check-row"><input type="checkbox" checked={consents.external_model} onChange={e => setConsents(c => ({ ...c, external_model: e.target.checked }))} />
              <span><b>Facultatif — </b>J'autorise l'envoi du texte de mes questions à un fournisseur de modèle externe ({org?.plan === 'solo' ? 'DeepSeek' : 'Anthropic, Claude Opus 5.5'}). Sans cette autorisation, rien n'est envoyé ; les factures sont préparées quand même.</span></label>
          </div>
        </>)}

        {step === 'team' && (<>
          <h1>Votre équipe</h1>
          <p className="muted" style={{ margin: 0 }}>Invitez une personne maintenant ou plus tard depuis les paramètres.</p>
          <div className="form-grid">
            <div className="field"><label>E-mail</label><input className="input" type="email" value={form.invite_email ?? ''} onChange={set('invite_email')} /></div>
            <div className="field"><label>Rôle</label><select className="input" value={form.invite_role ?? 'operator'} onChange={set('invite_role')}><option value="admin">Administrateur</option><option value="operator">Opérateur</option><option value="accountant">Comptable externe</option><option value="reader">Lecteur</option></select></div>
          </div>
        </>)}

        {step === 'done' && (<>
          <h1>Premiers pas</h1>
          <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
            <li>Créez un agent depuis « Packs d'agents » (pack Facturation).</li>
            <li>Déposez vos rapports d'activité : l'agent prépare les factures.</li>
            <li>Vérifiez et validez chaque facture. Rien n'est envoyé sans vous.</li>
          </ol>
          {me?.app.demoMode && (
            <div className="demo-banner"><b>Mode démonstration.</b> Chargez des données fictives : 3 clients miniers et leurs contrats, 25 crédits offerts, un agent Facturation prêt à l'emploi.</div>
          )}
        </>)}

        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="spread">
          {index > 0 && step !== 'done' && !(step === 'profile' && org) ? <button className="btn ghost" onClick={back}>Retour</button> : <span />}
          <div className="row">
            {['company', 'tax', 'tools', 'team'].includes(step) && <button className="btn ghost" onClick={next}>Passer</button>}
            {step === 'done' ? (<>
              {me?.app.demoMode && <button className="btn primary" disabled={busy} onClick={() => finish(true)}>Charger la démonstration et commencer</button>}
              <button className={`btn${me?.app.demoMode ? '' : ' primary'}`} disabled={busy} onClick={() => finish(false)}>Commencer</button>
            </>) : (
              <button className="btn primary" disabled={busy} onClick={save}>{busy ? <span className="spinner" /> : 'Continuer'}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
