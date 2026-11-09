/** Server configuration from environment variables. Misconfiguration fails at start-up. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

export interface Config {
  env: 'development' | 'production' | 'test'
  host: string
  port: number
  dataDir: string
  /** 32-byte key from which every organization's file key is derived. */
  masterKey: Buffer
  /** Demo mode: login codes are also shown on screen, demo seed allowed. Never in production. */
  demoMode: boolean
  /** Origin the browser uses (scheme://host:port); state-changing requests must come from it. */
  publicOrigin: string
  cookieSecure: boolean
  /** Shown in the interface: where the data is hosted (directive 4.4: never claim "Africa" falsely). */
  hostingLabel: string
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
    if (key.length !== 32) fail('AKILI_MASTER_KEY', 'must be 32 bytes, base64-encoded')
    return key
  }
  if (production) fail('AKILI_MASTER_KEY', 'is required in production (32 bytes, base64)')
  // Development and demo: a local key kept next to the data, readable by the owner only.
  const path = join(dataDir, 'master.key')
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
  mkdirSync(dataDir, { recursive: true })
  const key = randomBytes(32)
  writeFileSync(path, key.toString('base64'), { mode: 0o600 })
  chmodSync(path, 0o600)
  return key
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  const production = nodeEnv === 'production'
  const dataDir = resolve(env.AKILI_DATA_DIR ?? './data')
  const demoMode = env.AKILI_DEMO === '1'
  if (production && demoMode) fail('AKILI_DEMO', 'demo mode is not allowed in production')
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail('PORT', 'must be a TCP port')
  const publicOrigin = env.AKILI_PUBLIC_ORIGIN ?? `http://localhost:${port}`
  let origin: URL
  try { origin = new URL(publicOrigin) } catch { fail('AKILI_PUBLIC_ORIGIN', 'must be a URL') }
  if (production && origin.protocol !== 'https:') fail('AKILI_PUBLIC_ORIGIN', 'must use https in production')
  return {
    env: nodeEnv,
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port,
    dataDir,
    masterKey: readMasterKey(env, production, dataDir),
    demoMode,
    publicOrigin: origin.origin,
    cookieSecure: origin.protocol === 'https:',
    hostingLabel: env.AKILI_HOSTING_LABEL ?? (production ? fail('AKILI_HOSTING_LABEL', 'is required in production (real hosting region)') : 'Serveur local — démonstration'),
    webDist: env.AKILI_WEB_DIST,
    models: { deepseek: Boolean(env.DEEPSEEK_API_KEY), anthropic: Boolean(env.ANTHROPIC_API_KEY) },
  }
}
