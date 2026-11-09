/** Test helpers. Each test gets its own PostgreSQL schema (AKILI_TEST_DATABASE_URL), dropped afterwards. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { Mailer } from '../src/auth/mailer.js'
import { loadConfig, type Config } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'

export const TEST_DATABASE_URL = process.env.AKILI_TEST_DATABASE_URL ?? 'postgresql://akili:akili@127.0.0.1:5432/akili'
export const ORIGIN = 'http://localhost:3000'

export interface TestDb { db: Db; drop(): Promise<void> }

export async function testDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString('hex')}`
  const admin = await openDb(TEST_DATABASE_URL, { migrate: false })
  await admin.run(`CREATE SCHEMA ${schema}`)
  await admin.close()
  const db = await openDb(TEST_DATABASE_URL, { schema })
  return {
    db,
    async drop() {
      await db.close()
      const cleanup = await openDb(TEST_DATABASE_URL, { migrate: false })
      await cleanup.run(`DROP SCHEMA ${schema} CASCADE`)
      await cleanup.close()
    },
  }
}

/** Captures login codes instead of sending e-mails. */
export function captureMailer(): Mailer & { codes: Map<string, string>; fail: boolean } {
  const codes = new Map<string, string>()
  const mailer = {
    codes, fail: false,
    async sendLoginCode(email: string, code: string) {
      if (mailer.fail) throw new Error('smtp down')
      codes.set(email, code)
    },
  }
  return mailer
}

export interface TestContext {
  app: FastifyInstance
  db: Db
  config: Config
  mailer: ReturnType<typeof captureMailer>
  close(): Promise<void>
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), 'akili-test-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    AKILI_DATA_DIR: dataDir,
    AKILI_MASTER_KEY: randomBytes(32).toString('base64'),
    AKILI_PUBLIC_ORIGIN: ORIGIN,
    AKILI_SIGNUP_CREDITS: '0',
    ...overrides,
  })
  const { db, drop } = await testDb()
  const mailer = captureMailer()
  const app = await buildApp({ config, db, mailer })
  await app.ready()
  return {
    app, db, config, mailer,
    async close() {
      await app.close()
      await drop()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** Request a code and log in; returns the session cookie header value. */
export async function login(t: TestContext, email: string): Promise<string> {
  const req = await t.app.inject({ method: 'POST', url: '/api/auth/request-code', headers: { origin: ORIGIN }, payload: { email } })
  if (req.statusCode !== 200) throw new Error(`request-code ${req.statusCode} ${req.body}`)
  const code = t.mailer.codes.get(email.trim().toLowerCase())!
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload: { email, code } })
  if (res.statusCode !== 200) throw new Error(`verify ${res.statusCode} ${res.body}`)
  return String(res.headers['set-cookie']).split(';')[0]!
}

/** inject() with the session cookie and the browser Origin header. */
export function as(t: TestContext, cookie: string) {
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({ method, url, headers: { origin: ORIGIN, cookie, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
}

/** Build a multipart/form-data body for inject(). */
export function multipart(fields: Record<string, string>, file?: { field: string; filename: string; bytes: Buffer; type?: string }) {
  const boundary = `----akili${Math.random().toString(16).slice(2)}`
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`))
    parts.push(file.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

/** Log in and create a company organization with finished onboarding. */
export async function onboardedOwner(t: TestContext, email: string, name = 'Kibala Services SARL (fictif)') {
  const cookie = await login(t, email)
  const call = as(t, cookie)
  const res = await call('POST', '/api/orgs', { kind: 'company', name })
  if (res.statusCode !== 200) throw new Error(`create org ${res.statusCode} ${res.body}`)
  await call('POST', '/api/orgs/current/consents', { type: 'terms', granted: true })
  await call('POST', '/api/orgs/current/consents', { type: 'privacy', granted: true })
  const done = await call('POST', '/api/orgs/current/onboarding/complete', {})
  if (done.statusCode !== 200) throw new Error(`complete ${done.statusCode} ${done.body}`)
  return { cookie, orgId: res.json().org.id as string, call }
}

const fixturesDir = join(import.meta.dirname, '../../../fixtures')
const reportsDir = join(fixturesDir, 'reports')

/** Create the fictitious clients and contracts of fixtures/contracts.json through the API. */
export async function importFixtureClients(call: ReturnType<typeof as>): Promise<void> {
  const data = JSON.parse(readFileSync(join(fixturesDir, 'contracts.json'), 'utf8'))
  const p = data.provider
  const org = await call('PATCH', '/api/orgs/current', { address: p.address, rccm: p.rccm, id_nat: p.id_nat, nif: p.nif, bank_details: p.bank_details, vat_status: 'yes' })
  expect(org.statusCode).toBe(200)
  for (const c of data.clients) {
    const client = await call('POST', '/api/clients', { name: c.name, address: c.address, nif: c.nif, rccm: c.rccm, email: c.email, vat_applicable: c.vat_applicable })
    expect(client.statusCode, client.body).toBe(200)
    const contract = await call('POST', `/api/clients/${client.json().client.id}/contracts`, c.contract)
    expect(contract.statusCode, contract.body).toBe(200)
  }
}

/** Platform credit top-up, as the platform administrator would do. */
export async function grantCredits(t: TestContext, orgId: string, credits: number): Promise<void> {
  const { topup } = await import('../src/credits.js')
  await topup(t.db, orgId, credits, 'TEST-PAY', null)
}

/** Owner with clients, credits and an invoicing agent; `upload(name)` sends a fixture report. */
export async function readyOrg(ctx: TestContext, email = 'owner@example.cd', credits = 20) {
  const owner = await onboardedOwner(ctx, email)
  await importFixtureClients(owner.call)
  if (credits > 0) await grantCredits(ctx, owner.orgId, credits)
  const agent = (await owner.call('POST', '/api/agents', { packId: 'facturation-sous-traitance', name: 'Agent Facturation' })).json().agent
  const upload = async (name: string) => {
    const body = multipart({ agentId: agent.id }, { field: 'file', filename: name, bytes: readFileSync(join(reportsDir, name)) })
    return ctx.app.inject({ method: 'POST', url: '/api/documents', headers: { origin: ORIGIN, cookie: owner.cookie, ...body.headers }, payload: body.payload })
  }
  return { ...owner, agent, upload }
}
