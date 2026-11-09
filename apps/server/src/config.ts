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
}

function fail(name: string, why: string): never {
  throw new Error(`config: ${name} ${why}`)
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
  }
}
