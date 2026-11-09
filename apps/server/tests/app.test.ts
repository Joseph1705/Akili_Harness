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

  it('answers unknown API routes with a JSON 404', async () => {
    t = await createTestApp()
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })

  it('refuses production without a 32-byte master key', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AKILI_DATA_DIR: '/tmp/x', AKILI_PUBLIC_ORIGIN: 'https://a.example' })).toThrow(/AKILI_MASTER_KEY/)
    expect(() => loadConfig({ NODE_ENV: 'production', AKILI_DATA_DIR: '/tmp/x', AKILI_PUBLIC_ORIGIN: 'https://a.example', AKILI_MASTER_KEY: 'c2hvcnQ=' })).toThrow(/32/)
  })

  it('never runs demo mode in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production', AKILI_DATA_DIR: '/tmp/x', AKILI_PUBLIC_ORIGIN: 'https://a.example',
      AKILI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), AKILI_DEMO: '1',
    })).toThrow(/demo/i)
  })
})
