/**
 * What Administration › Clés API et services may set. Each field stands for the .env variable of the same name;
 * nothing outside this list can be set from the interface: never the operators' addresses, the database, the master
 * key, e-mail sending, nor the "this model runs on our network" switches (AKILI_LOCAL_MODEL_EXTERNAL,
 * AKILI_EMBEDDINGS_EXTERNAL) that would skip the organization's consent and pseudonymisation (rule 5).
 */
import { badRequest } from '../errors.js'

export type SectionId = 'anthropic' | 'deepseek' | 'other_model' | 'embeddings' | 'saspay' | 'google' | 'whatsapp' | 'platform'
export type FieldKind = 'secret' | 'text' | 'url' | 'email' | 'int' | 'select'

export interface SettingField {
  key: string
  label: string
  kind: FieldKind
  help?: string
  placeholder?: string
  options?: ReadonlyArray<{ value: string; label: string }>
  min?: number
  max?: number
  /** Shape a text value must have, with an example for the message. */
  pattern?: { re: RegExp; example: string }
  maxLength?: number
}

export interface SettingSection {
  id: SectionId
  title: string
  description: string
  fields: readonly SettingField[]
  testable: boolean
  /** Rule across fields, on the values in effect (.env file + screen): a message in French when broken. */
  check?: (env: Readonly<Record<string, string | undefined>>) => string | null
}

export const SASPAY_LIVE = 'https://api.saspay.me/api/v1'
export const SASPAY_SANDBOX = 'https://sandbox-api.saspay.me/api/v1'

type Env = Readonly<Record<string, string | undefined>>
const has = (env: Env, key: string) => Boolean(env[key]?.trim())
const together = (a: string, b: string, message: string) => (env: Env) => has(env, a) !== has(env, b) ? message : null
const needs = (a: string, b: string, message: string) => (env: Env) => has(env, a) && !has(env, b) ? message : null

export const SECTIONS: readonly SettingSection[] = [
  {
    id: 'anthropic',
    title: 'Claude (Anthropic)',
    description: "Modèles de l'offre Entreprise. Clé à créer sur console.anthropic.com, rubrique API Keys.",
    testable: true,
    fields: [
      { key: 'ANTHROPIC_API_KEY', label: 'Clé API', kind: 'secret', placeholder: 'sk-ant-…' },
      { key: 'AKILI_ANTHROPIC_MODEL_LIGHT', label: 'Modèle léger (tâches courtes)', kind: 'text', placeholder: 'claude-haiku-5-5' },
      { key: 'AKILI_ANTHROPIC_MODEL_HEAVY', label: 'Modèle lourd (documents longs, outils)', kind: 'text', placeholder: 'claude-opus-5-5' },
    ],
  },
  {
    id: 'deepseek',
    title: 'DeepSeek',
    description: "Modèles de l'offre Entrepreneur individuel. Clé à créer sur platform.deepseek.com, rubrique API keys. Vérifiez les noms des modèles sur leur site, puis « Tester ».",
    testable: true,
    fields: [
      { key: 'DEEPSEEK_API_KEY', label: 'Clé API', kind: 'secret', placeholder: 'sk-…' },
      { key: 'AKILI_DEEPSEEK_MODEL_LIGHT', label: 'Modèle léger (tâches courtes)', kind: 'text', placeholder: 'deepseek-flash' },
      { key: 'AKILI_DEEPSEEK_MODEL_HEAVY', label: 'Modèle lourd (documents longs, outils)', kind: 'text', placeholder: 'deepseek-v4-pro' },
    ],
  },
  {
    id: 'other_model',
    title: 'Autre modèle (compatible OpenAI)',
    description: "OpenAI, Mistral, Gemini, Groq, OpenRouter, ou un modèle installé chez nous (Ollama). Une adresse hors de notre réseau est un fournisseur externe : il ne sert qu'aux organisations qui ont consenti, et ne reçoit que du texte pseudonymisé.",
    testable: true,
    fields: [
      {
        key: 'AKILI_LOCAL_MODEL_URL', label: "Adresse de l'API", kind: 'url', placeholder: 'https://api.openai.com/v1',
        help: 'Mistral : https://api.mistral.ai/v1 · Gemini : https://generativelanguage.googleapis.com/v1beta/openai · Groq : https://api.groq.com/openai/v1 · Ollama chez nous : http://ollama:11434/v1',
      },
      { key: 'AKILI_LOCAL_MODEL_KEY', label: 'Clé API', kind: 'secret', help: 'Inutile pour un modèle installé chez nous.' },
      { key: 'AKILI_LOCAL_MODEL_HEAVY', label: 'Modèle lourd', kind: 'text', placeholder: 'Nom exact chez le fournisseur' },
      { key: 'AKILI_LOCAL_MODEL_LIGHT', label: 'Modèle léger (facultatif)', kind: 'text', placeholder: 'Sans valeur : le modèle lourd' },
    ],
    check: needs('AKILI_LOCAL_MODEL_URL', 'AKILI_LOCAL_MODEL_HEAVY', 'Indiquez le nom du modèle lourd servi à cette adresse.'),
  },
  {
    id: 'embeddings',
    title: 'Recherche par le sens (base de connaissances)',
    description: "Facultatif : sans ce réglage, la recherche par mots reste active. Service compatible OpenAI (/embeddings) ; il ne sert qu'aux organisations qui ont consenti à un fournisseur externe.",
    testable: true,
    fields: [
      { key: 'AKILI_EMBEDDINGS_URL', label: "Adresse de l'API", kind: 'url', placeholder: 'https://api.openai.com/v1' },
      { key: 'AKILI_EMBEDDINGS_KEY', label: 'Clé API', kind: 'secret' },
      { key: 'AKILI_EMBEDDINGS_MODEL', label: "Modèle d'embeddings", kind: 'text', placeholder: 'Nom exact chez le fournisseur' },
    ],
    check: needs('AKILI_EMBEDDINGS_URL', 'AKILI_EMBEDDINGS_MODEL', "Indiquez le nom du modèle d'embeddings."),
  },
  {
    id: 'saspay',
    title: 'Paiement SasPay (achat de crédits)',
    description: "Clés du tableau de bord SasPay. Commencez en bac à sable avec une clé sk_test_… : c'est l'environnement choisi ici qui décide si l'argent est réel, pas la clé.",
    testable: false,
    fields: [
      { key: 'SASPAY_API_KEY', label: 'Clé API', kind: 'secret', placeholder: 'sk_live_… ou sk_test_…' },
      { key: 'SASPAY_WEBHOOK_SECRET', label: 'Secret de signature du webhook', kind: 'secret', help: 'Sans lui, les paiements sont quand même vérifiés auprès de SasPay, toutes les 3 minutes.' },
      {
        key: 'SASPAY_BASE_URL', label: 'Environnement', kind: 'select', placeholder: 'Par défaut : réel (argent réel)',
        options: [{ value: SASPAY_LIVE, label: 'Réel (argent réel)' }, { value: SASPAY_SANDBOX, label: 'Bac à sable (test, sans argent réel)' }],
      },
    ],
  },
  {
    id: 'google',
    title: 'Google (Gmail et Google Sheets)',
    description: "Client OAuth « Application Web » créé dans Google Cloud Console, avec les API Gmail et Google Sheets activées. Chaque organisation connecte ensuite son propre compte Google dans ses paramètres.",
    testable: true,
    fields: [
      { key: 'GOOGLE_CLIENT_ID', label: 'ID client', kind: 'text', placeholder: '….apps.googleusercontent.com' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Code secret du client', kind: 'secret' },
    ],
    check: together('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', "Renseignez l'ID client et le code secret Google ensemble (ou retirez les deux)."),
  },
  {
    id: 'whatsapp',
    title: 'WhatsApp Business (Meta)',
    description: "Application Meta de la plateforme WhatsApp Business. Chaque organisation connecte ensuite son propre numéro (identifiant du numéro et jeton) dans ses paramètres.",
    testable: false,
    fields: [
      { key: 'WHATSAPP_APP_SECRET', label: "Clé secrète de l'application Meta", kind: 'secret' },
      { key: 'WHATSAPP_VERIFY_TOKEN', label: 'Jeton de vérification du webhook', kind: 'text', help: "Un mot de passe que vous choisissez, à recopier tel quel chez Meta avec l'URL de rappel." },
      { key: 'WHATSAPP_GRAPH_VERSION', label: "Version de l'API Graph", kind: 'text', placeholder: 'v23.0', pattern: { re: /^v\d{1,3}\.\d{1,2}$/, example: 'v23.0' } },
    ],
    check: together('WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', "Renseignez la clé secrète de l'application et le jeton de vérification ensemble (ou retirez les deux)."),
  },
  {
    id: 'platform',
    title: 'Plateforme',
    description: 'Ce que voient les clients.',
    testable: false,
    fields: [
      { key: 'AKILI_BRAND_NAME', label: 'Nom du produit affiché', kind: 'text', placeholder: 'Akili', maxLength: 60 },
      { key: 'AKILI_SUPPORT_EMAIL', label: "Adresse d'aide affichée aux clients", kind: 'email' },
      { key: 'AKILI_SIGNUP_CREDITS', label: 'Crédits offerts à chaque nouvelle organisation', kind: 'int', min: 0, max: 10_000, placeholder: '10' },
    ],
  },
]

/** Control characters (line breaks, tabs, NUL…) and the Unicode line and paragraph separators. */
const isInvisible = (c: string) => { const n = c.codePointAt(0)!; return n < 0x20 || n === 0x7f || n === 0x2028 || n === 0x2029 }

/**
 * The values an operator sent for one section, cleaned: trimmed (keys copied from a web console often carry a space
 * or a line break), an empty value meaning "remove". Throws a 400 with a message in French on the first bad value.
 */
export function normalizeChanges(section: SettingSection, values: Record<string, string | null>): Map<string, string | null> {
  const changes = new Map<string, string | null>()
  for (const [key, raw] of Object.entries(values)) {
    const field = section.fields.find(f => f.key === key)
    if (!field) throw badRequest(`« ${section.title} » n'a pas de réglage ${key.slice(0, 60)}.`)
    const value = raw?.trim() ?? ''
    if (value === '') { changes.set(key, null); continue }
    if ([...value].some(isInvisible)) throw badRequest(`« ${field.label} » contient un retour à la ligne ou un caractère invisible : collez la valeur sur une seule ligne.`)
    if (value.length > (field.maxLength ?? 2000)) throw badRequest(`« ${field.label} » est trop long.`)
    const problem = invalid(field, value)
    if (problem) throw badRequest(problem)
    changes.set(key, value)
  }
  return changes
}

function invalid(field: SettingField, value: string): string | null {
  switch (field.kind) {
    case 'url': {
      let url: URL
      try { url = new URL(value) } catch { return `« ${field.label} » doit être une adresse web complète (https://…).` }
      return url.protocol === 'https:' || url.protocol === 'http:' ? null : `« ${field.label} » doit commencer par https://.`
    }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : `« ${field.label} » doit être une adresse e-mail.`
    case 'int': {
      const n = Number(value)
      return /^\d+$/.test(value) && n >= (field.min ?? 0) && n <= (field.max ?? Number.MAX_SAFE_INTEGER)
        ? null : `« ${field.label} » doit être un nombre entier entre ${field.min ?? 0} et ${field.max}.`
    }
    case 'select':
      return field.options?.some(o => o.value === value) ? null : `Choix invalide pour « ${field.label} ».`
    default:
      return field.pattern && !field.pattern.re.test(value) ? `« ${field.label} » doit ressembler à ${field.pattern.example}.` : null
  }
}
