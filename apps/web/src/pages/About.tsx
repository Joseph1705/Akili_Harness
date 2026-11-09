/** Design screen F — À propos, with the DeepSeek Harness MIT notice next to ours (rule 2). */
import { useEffect, useState } from 'react'
import { Shell } from '../components/Shell'
import { useSession } from '../state'

export function About() {
  const { me, config } = useSession()
  const [license, setLicense] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  useEffect(() => { fetch('/api/orgs/current/consents', { credentials: 'same-origin' }).then(r => r.json()).then(c => setConsent(Boolean(c.external_model))).catch(() => undefined) }, [])
  const modelConfigured = me?.org?.plan === 'solo' ? me?.app.models.deepseek : me?.app.models.anthropic
  const outside = modelConfigured && consent ? 'Texte des questions à l\'assistant, avec votre consentement' : 'Aucune'
  return (
    <Shell crumb="Informations" title="À propos">
      <div className="page">
        <div className="about">
          <div className="version-block">
            <img src="/brand/tete-ivoire.png" alt="" />
            <div className="spread mono small"><span>Version {config?.version}</span><span>build 2026.11.09</span></div>
          </div>
          <div className="stack" style={{ gap: 18 }}>
            <div className="eyebrow" style={{ color: 'var(--green-ink)' }}>Agents IA souverains · Afrique centrale</div>
            <h1 style={{ fontSize: 34 }}>{me?.app.brand}</h1>
            <p style={{ fontFamily: 'var(--serif)', fontSize: 20, margin: 0 }}>Vos données restent sous votre contrôle. Les agents préparent, vous décidez ; chaque calcul est fait par le code et vérifiable.</p>
            <dl className="facts">
              <dt>Hébergement</dt><dd>{me?.app.hostingLabel}</dd>
              <dt>Modèle de langage</dt><dd>{me?.org?.plan === 'solo' ? 'DeepSeek (offre Entrepreneur individuel)' : 'Claude Opus 5.5 (offre Entreprise)'} · {modelConfigured ? 'configuré' : 'non configuré sur ce serveur'}</dd>
              <dt>Données envoyées à l'extérieur</dt><dd>{outside}</dd>
              <dt>Fichiers</dt><dd>Chiffrés au repos (AES-256-GCM), une clé par organisation</dd>
              <dt>Assistance</dt><dd>Équipe locale, du lundi au samedi</dd>
            </dl>
            <div className="license">
              <span style={{ color: 'var(--copper)' }}>◆</span>
              <div className="grow small"><b>Basé sur DeepSeek Harness, licence MIT.</b> Copyright (c) 2026 DeepSeek. Code source et avis de licence fournis avec chaque installation. © 2026 {me?.app.brand} pour le reste du produit.</div>
              <button className="btn small" onClick={() => fetch('/licenses/deepseek-harness.txt').then(r => r.text()).then(setLicense)}>Voir la licence</button>
            </div>
            {license && <div className="card card-pad"><pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{license}</pre></div>}
          </div>
        </div>
      </div>
    </Shell>
  )
}
