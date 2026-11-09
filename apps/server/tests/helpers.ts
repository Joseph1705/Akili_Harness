import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'

export interface TestContext {
  app: FastifyInstance
  db: Db
  config: Config
  close(): Promise<void>
}

export const ORIGIN = 'http://localhost:3000'

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), 'akili-test-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    AKILI_DATA_DIR: dataDir,
    AKILI_MASTER_KEY: randomBytes(32).toString('base64'),
    AKILI_PUBLIC_ORIGIN: ORIGIN,
    AKILI_DEMO: '1',
    ...overrides,
  })
  const db = openDb(join(dataDir, 'akili.db'))
  const app = await buildApp({ config, db })
  await app.ready()
  return {
    app, db, config,
    async close() {
      await app.close()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** Request a code and log in; returns the session cookie header value. */
export async function login(t: TestContext, email: string): Promise<string> {
  const req = await t.app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { origin: ORIGIN }, payload: { email } })
  if (req.statusCode !== 200) throw new Error(`request-code ${req.statusCode} ${req.body}`)
  const code = req.json().demoCode as string
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload: { email, code } })
  if (res.statusCode !== 200) throw new Error(`verify ${res.statusCode} ${res.body}`)
  const cookie = String(res.headers['set-cookie']).split(';')[0]!
  return cookie
}

/** inject() with the session cookie and the browser Origin header. */
export function as(t: TestContext, cookie: string) {
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
}
