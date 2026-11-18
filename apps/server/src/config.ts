/** Server configuration from environment variables. Misconfiguration fails at start-up, before serving anyone. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

export interface SmtpConfig {
  host: string
  port: number
  /** true: TLS from the first byte (port 465). false: STARTTLS (port 587). */
  secure: boolean
  user: string
  password: string
  /** Sender shown to users, e.g. "Akili <josephprods@gmail.com>". */
  from: string
}

export interface Config {
  env: 'development' | 'production' | 'test'
  host: string
  port: number
  databaseUrl: string
  /** Encrypted organization files live under <dataDir>/blobs. */
  dataDir: string
  /** 32-byte key from which every organization's file key is derived. */
  masterKey: Buffer
  /** Origin the browser uses (scheme://host[:port]); state-changing requests must come from it. */
  publicOrigin: string
  cookieSecure: boolean
  /** Where the data is hosted, shown in the interface (directive 4.4: the real region, never "Africa" by default). */
  hostingLabel: string
  /** Product name shown in the interface; [NOM_MARQUE] until the founder chooses (directive). */
  brand: string
  /** Undefined in development: login codes go to the server console only. */
  smtp: SmtpConfig | undefined
  /** E-mail addresses of the platform operators (us): they credit organizations until payment is integrated. */
  platformAdmins: string[]
  /** Shown to organizations that need credits or help, until payment is integrated. */
  supportEmail: string | undefined
  /** Credits given to each new organization. */
  signupCredits: number
  /** Built web interface to serve, when present. */
  webDist: string | undefined
  /** Model keys present in the environment (values never stored here). */
  models: { deepseek: boolean; anthropic: boolean }
  /** SasPay credentials; undefined: online payment unavailable (never simulated). */
  saspay: { baseUrl: string; apiKey: string; webhookSecret: string | undefined } | undefined
  /** OCR of scans and photos, on this server. */
  ocr: { enabled: boolean; maxPages: number }
  /** ClamAV daemon scanning every upload; undefined: not configured. */
  antivirus: { host: string; port: number } | undefined
  /** Language models, embeddings and connectors available on this server (keys stay in the environment). */
  ai: AiConfig
  connectors: ConnectorConfig
  /** MCP servers on private networks (self-hosted installs only). Off by default: SSRF protection. */
  mcpAllowPrivate: boolean
}

export interface ModelEndpoint { apiKey: string; baseUrl: string | undefined; models: { light: string; heavy: string } }

export interface AiConfig {
  /** Claude, through the official Anthropic SDK (offer Entreprise). */
  anthropic: ModelEndpoint | undefined
  /** DeepSeek's OpenAI-compatible API (offer Entrepreneur individuel). */
  deepseek: (ModelEndpoint & { baseUrl: string }) | undefined
  /** A model on our own or the customer's machine (Ollama or any OpenAI-compatible server): no data leaves. */
  local: { baseUrl: string; apiKey: string | undefined; models: { light: string; heavy: string } } | undefined
  /** Embeddings for knowledge search (OpenAI-compatible /embeddings). `external` providers need consent. */
  embeddings: { baseUrl: string; apiKey: string | undefined; model: string; external: boolean } | undefined
  /** Response cache lifetime. 0 disables the cache. */
  cacheTtlHours: number
}

export interface ConnectorConfig {
  /** Google OAuth client (Gmail, Sheets, Drive later). Base URLs are overridable for tests only. */
  google: { clientId: string; clientSecret: string; authUrl: string; tokenUrl: string; gmailBase: string; sheetsBase: string; userinfoUrl: string; revokeUrl: string } | undefined
  /** Our Meta app for the WhatsApp Business Platform (Cloud API): webhook secret and verify token. */
  whatsapp: { appSecret: string; verifyToken: string; graphBase: string; graphVersion: string } | undefined
}

function fail(name: string, why: string): never {
  throw new Error(`config: ${name} ${why}`)
}

function url(env: NodeJS.ProcessEnv, name: string, fallback?: string): string | undefined {
  const raw = env[name]?.trim() || fallback
  if (!raw) return undefined
  try { new URL(raw) } catch { fail(name, 'must be a URL') }
  return raw.replace(/\/+$/, '')
}

function readAi(env: NodeJS.ProcessEnv): AiConfig {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim()
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim()
  const localUrl = url(env, 'AKILI_LOCAL_MODEL_URL')
  const embeddingsUrl = url(env, 'AKILI_EMBEDDINGS_URL')
  if (localUrl && !env.AKILI_LOCAL_MODEL_HEAVY?.trim()) fail('AKILI_LOCAL_MODEL_HEAVY', 'is required with AKILI_LOCAL_MODEL_URL (the model name served there)')
  if (embeddingsUrl && !env.AKILI_EMBEDDINGS_MODEL?.trim()) fail('AKILI_EMBEDDINGS_MODEL', 'is required with AKILI_EMBEDDINGS_URL')
  return {
    anthropic: anthropicKey ? {
      apiKey: anthropicKey, baseUrl: url(env, 'ANTHROPIC_BASE_URL'),
      models: { light: env.AKILI_ANTHROPIC_MODEL_LIGHT?.trim() || 'claude-haiku-5-5', heavy: env.AKILI_ANTHROPIC_MODEL_HEAVY?.trim() || 'claude-opus-5-5' },
    } : undefined,
    deepseek: deepseekKey ? {
      apiKey: deepseekKey, baseUrl: url(env, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com')!,
      // Names from the model catalog of the pinned DeepSeek Harness; to verify on DeepSeek's site (rule 12).
      models: { light: env.AKILI_DEEPSEEK_MODEL_LIGHT?.trim() || 'deepseek-flash', heavy: env.AKILI_DEEPSEEK_MODEL_HEAVY?.trim() || 'deepseek-v4-pro' },
    } : undefined,
    local: localUrl ? {
      baseUrl: localUrl, apiKey: env.AKILI_LOCAL_MODEL_KEY?.trim() || undefined,
      models: { light: env.AKILI_LOCAL_MODEL_LIGHT?.trim() || env.AKILI_LOCAL_MODEL_HEAVY!.trim(), heavy: env.AKILI_LOCAL_MODEL_HEAVY!.trim() },
    } : undefined,
    embeddings: embeddingsUrl ? {
      baseUrl: embeddingsUrl, apiKey: env.AKILI_EMBEDDINGS_KEY?.trim() || undefined, model: env.AKILI_EMBEDDINGS_MODEL!.trim(),
      external: env.AKILI_EMBEDDINGS_EXTERNAL !== '0',
    } : undefined,
    cacheTtlHours: intIn(env.AKILI_AI_CACHE_HOURS, 24, 0, 24 * 30, 'AKILI_AI_CACHE_HOURS'),
  }
}

function readConnectors(env: NodeJS.ProcessEnv): ConnectorConfig {
  const id = env.GOOGLE_CLIENT_ID?.trim()
  const secret = env.GOOGLE_CLIENT_SECRET?.trim()
  if (Boolean(id) !== Boolean(secret)) fail('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET', 'set both or none')
  const appSecret = env.WHATSAPP_APP_SECRET?.trim()
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim()
  if (Boolean(appSecret) !== Boolean(verifyToken)) fail('WHATSAPP_APP_SECRET/WHATSAPP_VERIFY_TOKEN', 'set both or none')
  return {
    google: id && secret ? {
      clientId: id, clientSecret: secret,
      authUrl: url(env, 'GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth')!,
      tokenUrl: url(env, 'GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token')!,
      userinfoUrl: url(env, 'GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo')!,
      revokeUrl: url(env, 'GOOGLE_REVOKE_URL', 'https://oauth2.googleapis.com/revoke')!,
      gmailBase: url(env, 'GOOGLE_GMAIL_BASE', 'https://gmail.googleapis.com')!,
      sheetsBase: url(env, 'GOOGLE_SHEETS_BASE', 'https://sheets.googleapis.com')!,
    } : undefined,
    whatsapp: appSecret && verifyToken ? {
      appSecret, verifyToken,
      graphBase: url(env, 'WHATSAPP_GRAPH_BASE', 'https://graph.facebook.com')!,
      graphVersion: env.WHATSAPP_GRAPH_VERSION?.trim() || 'v23.0',
    } : undefined,
  }
}

function readMasterKey(env: NodeJS.ProcessEnv, production: boolean, dataDir: string): Buffer {
  const raw = env.AKILI_MASTER_KEY
  if (raw) {
    const key = Buffer.from(raw, 'base64')
    if (key.length !== 32) fail('AKILI_MASTER_KEY', 'must be 32 bytes, base64-encoded (openssl rand -base64 32)')
    return key
  }
  if (production) fail('AKILI_MASTER_KEY', 'is required in production (openssl rand -base64 32)')
  // Development only: a local key next to the data, readable by the owner only.
  const path = join(dataDir, 'master.key')
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
  mkdirSync(dataDir, { recursive: true })
  const key = randomBytes(32)
  writeFileSync(path, key.toString('base64'), { mode: 0o600 })
  chmodSync(path, 0o600)
  return key
}

function intIn(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) fail(name, `must be an integer between ${min} and ${max}`)
  return n
}

function readSasPay(env: NodeJS.ProcessEnv, production: boolean): Config['saspay'] {
  const apiKey = env.SASPAY_API_KEY?.trim()
  if (!apiKey) return undefined
  const baseUrl = (env.SASPAY_BASE_URL?.trim() || 'https://api.saspay.me/api/v1').replace(/\/+$/, '')
  let url: URL
  try { url = new URL(baseUrl) } catch { fail('SASPAY_BASE_URL', 'must be a URL') }
  if (production && url.protocol !== 'https:') fail('SASPAY_BASE_URL', 'must use https in production')
  return { baseUrl, apiKey, webhookSecret: env.SASPAY_WEBHOOK_SECRET?.trim() || undefined }
}

function readSmtp(env: NodeJS.ProcessEnv, production: boolean): SmtpConfig | undefined {
  const keys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const
  const present = keys.filter(k => env[k])
  if (present.length === 0) {
    if (production) fail('SMTP_HOST/SMTP_USER/SMTP_PASSWORD', 'are required in production: login codes are sent by e-mail')
    return undefined
  }
  if (present.length !== keys.length) fail(keys.filter(k => !env[k]).join(', '), 'missing: set all SMTP variables or none')
  const port = Number(env.SMTP_PORT ?? 465)
  if (!Number.isInteger(port) || port <= 0) fail('SMTP_PORT', 'must be a port number')
  return {
    host: env.SMTP_HOST!, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER!, password: env.SMTP_PASSWORD!, from: env.MAIL_FROM ?? env.SMTP_USER!,
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  const production = nodeEnv === 'production'
  const dataDir = resolve(env.AKILI_DATA_DIR ?? './data')
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('PORT', 'must be a TCP port')
  const databaseUrl = env.DATABASE_URL ?? fail('DATABASE_URL', 'is required (postgresql://user:password@host:5432/db)')
  const publicOrigin = env.AKILI_PUBLIC_ORIGIN ?? (production ? fail('AKILI_PUBLIC_ORIGIN', 'is required in production (https://app.your-domain)') : `http://localhost:${port}`)
  let origin: URL
  try { origin = new URL(publicOrigin) } catch { fail('AKILI_PUBLIC_ORIGIN', 'must be a URL') }
  // Before the domain exists the server may be reached by IP over plain HTTP; cookies then cannot be Secure.
  if (production && origin.protocol !== 'https:' && env.AKILI_ALLOW_HTTP !== '1') {
    fail('AKILI_PUBLIC_ORIGIN', 'must use https in production (set AKILI_ALLOW_HTTP=1 only for a first test by IP)')
  }
  const signupCredits = Number(env.AKILI_SIGNUP_CREDITS ?? 10)
  if (!Number.isInteger(signupCredits) || signupCredits < 0) fail('AKILI_SIGNUP_CREDITS', 'must be an integer >= 0')
  return {
    env: nodeEnv,
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port,
    databaseUrl,
    dataDir,
    masterKey: readMasterKey(env, production, dataDir),
    publicOrigin: origin.origin,
    cookieSecure: origin.protocol === 'https:',
    hostingLabel: env.AKILI_HOSTING_LABEL ?? (production ? fail('AKILI_HOSTING_LABEL', 'is required in production (real hosting region, e.g. "Hébergé en France")') : 'Serveur de développement'),
    brand: env.AKILI_BRAND_NAME?.trim() || 'Akili',
    smtp: readSmtp(env, production),
    platformAdmins: (env.AKILI_PLATFORM_ADMINS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    signupCredits,
    supportEmail: env.AKILI_SUPPORT_EMAIL?.trim() || undefined,
    webDist: env.AKILI_WEB_DIST,
    models: { deepseek: Boolean(env.DEEPSEEK_API_KEY), anthropic: Boolean(env.ANTHROPIC_API_KEY) },
    saspay: readSasPay(env, production),
    ocr: { enabled: env.AKILI_OCR !== 'off', maxPages: intIn(env.AKILI_OCR_MAX_PAGES, 10, 1, 50, 'AKILI_OCR_MAX_PAGES') },
    antivirus: env.CLAMAV_HOST?.trim() ? { host: env.CLAMAV_HOST.trim(), port: intIn(env.CLAMAV_PORT, 3310, 1, 65535, 'CLAMAV_PORT') } : undefined,
    ai: readAi(env),
    connectors: readConnectors(env),
    mcpAllowPrivate: env.AKILI_MCP_ALLOW_PRIVATE === '1',
  }
}
