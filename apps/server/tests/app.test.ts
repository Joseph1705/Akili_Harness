import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createTestApp, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('server foundation', () => {
  it('answers the health check', async () => {
    t = await createTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('sends security headers', async () => {
    t = await createTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('upgrades requests to HTTPS only when the site is served over HTTPS', async () => {
    t = await createTestApp()
    const http = await t.app.inject({ method: 'GET', url: '/api/health' })
    expect(http.headers['content-security-policy']).not.toContain('upgrade-insecure-requests')
    await t.close()
    t = await createTestApp({ AKILI_PUBLIC_ORIGIN: 'https://app.example.cd' })
    const https = await t.app.inject({ method: 'GET', url: '/api/health' })
    expect(https.headers['content-security-policy']).toContain('upgrade-insecure-requests')
    expect(https.headers['strict-transport-security']).toContain('max-age=')
  })

  it('answers unknown API routes with a JSON 404', async () => {
    t = await createTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })

  const prod = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://x@db/x', AKILI_DATA_DIR: '/tmp/x', AKILI_PUBLIC_ORIGIN: 'https://app.example.cd',
    AKILI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), AKILI_HOSTING_LABEL: 'Hébergé en France',
    SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'josephprods@gmail.com', SMTP_PASSWORD: 'app-password',
  }

  it('starts in production only with every required setting', () => {
    expect(loadConfig(prod).smtp).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, from: 'josephprods@gmail.com' })
    for (const key of ['DATABASE_URL', 'AKILI_MASTER_KEY', 'AKILI_PUBLIC_ORIGIN', 'AKILI_HOSTING_LABEL', 'SMTP_HOST'] as const) {
      const env: Record<string, string> = { ...prod }
      delete env[key]
      expect(() => loadConfig(env), key).toThrow(key === 'SMTP_HOST' ? /SMTP/ : new RegExp(key))
    }
    expect(() => loadConfig({ ...prod, AKILI_MASTER_KEY: 'c2hvcnQ=' })).toThrow(/32/)
  })

  it('refuses plain HTTP in production unless explicitly allowed for a first test by IP', () => {
    expect(() => loadConfig({ ...prod, AKILI_PUBLIC_ORIGIN: 'http://203.0.113.5' })).toThrow(/https/)
    expect(loadConfig({ ...prod, AKILI_PUBLIC_ORIGIN: 'http://203.0.113.5', AKILI_ALLOW_HTTP: '1' }).cookieSecure).toBe(false)
  })

  it('refuses a partial SMTP configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://x@db/x', AKILI_DATA_DIR: '/tmp/akili-x', SMTP_HOST: 'smtp.gmail.com' })).toThrow(/SMTP_USER/)
  })
})
