import { afterEach, describe, expect, it, vi } from 'vitest'
import { as, createTestApp, login, ORIGIN, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { vi.useRealTimers(); await t?.close(); t = undefined })

const post = (url: string, payload: object, headers: Record<string, string> = { origin: ORIGIN }) =>
  t!.app.inject({ method: 'POST', url, headers, payload })

describe('login by e-mail code', () => {
  it('logs in with a valid code and sets a safe cookie', async () => {
    t = await createTestApp()
    const res1 = await post('/api/auth/request-code', { email: 'Mireille@Example.CD' })
    expect(res1.statusCode).toBe(200)
    const code = res1.json().demoCode
    expect(code).toMatch(/^\d{6}$/)
    const res2 = await post('/api/auth/verify', { email: 'mireille@example.cd', code })
    expect(res2.statusCode).toBe(200)
    const cookie = String(res2.headers['set-cookie'])
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    const me = await as(t, cookie.split(';')[0]!)('GET', '/api/auth/me')
    expect(me.json().user.email).toBe('mireille@example.cd')
    expect(me.json().org).toBeNull()
  })

  it('does not reveal the code outside demo mode', async () => {
    t = await createTestApp({ AKILI_DEMO: '0' })
    const res = await post('/api/auth/request-code', { email: 'a@example.cd' })
    expect(res.statusCode).toBe(200)
    expect(res.json().demoCode).toBeUndefined()
  })

  it('refuses a wrong code and locks after 5 attempts', async () => {
    t = await createTestApp()
    const code = (await post('/api/auth/request-code', { email: 'a@example.cd' })).json().demoCode as string
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/verify', { email: 'a@example.cd', code: wrong })).statusCode).toBe(400)
    expect((await post('/api/auth/verify', { email: 'a@example.cd', code })).statusCode).toBe(400)
  })

  it('refuses an expired code', async () => {
    t = await createTestApp()
    const code = (await post('/api/auth/request-code', { email: 'a@example.cd' })).json().demoCode as string
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    expect((await post('/api/auth/verify', { email: 'a@example.cd', code })).statusCode).toBe(400)
  })

  it('a code works only once', async () => {
    t = await createTestApp()
    const code = (await post('/api/auth/request-code', { email: 'a@example.cd' })).json().demoCode as string
    expect((await post('/api/auth/verify', { email: 'a@example.cd', code })).statusCode).toBe(200)
    expect((await post('/api/auth/verify', { email: 'a@example.cd', code })).statusCode).toBe(400)
  })

  it('limits code requests per address', async () => {
    t = await createTestApp()
    for (let i = 0; i < 3; i++) expect((await post('/api/auth/request-code', { email: 'a@example.cd' })).statusCode).toBe(200)
    expect((await post('/api/auth/request-code', { email: 'a@example.cd' })).statusCode).toBe(429)
  })

  it('rejects malformed addresses', async () => {
    t = await createTestApp()
    expect((await post('/api/auth/request-code', { email: 'pas-une-adresse' })).statusCode).toBe(400)
  })
})

describe('sessions', () => {
  it('rejects state-changing requests from another origin or without origin', async () => {
    t = await createTestApp()
    expect((await post('/api/auth/request-code', { email: 'a@example.cd' }, { origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await post('/api/auth/request-code', { email: 'a@example.cd' }, {})).statusCode).toBe(403)
  })

  it('lists and revokes devices; a revoked session is refused', async () => {
    t = await createTestApp()
    const phone = await login(t, 'a@example.cd')
    const laptop = await login(t, 'a@example.cd')
    const list = await as(t, laptop)('GET', '/api/auth/sessions')
    expect(list.json().sessions).toHaveLength(2)
    const other = list.json().sessions.find((s: { current: boolean }) => !s.current)
    expect((await as(t, laptop)('DELETE', `/api/auth/sessions/${other.id}`)).statusCode).toBe(200)
    expect((await as(t, phone)('GET', '/api/auth/me')).statusCode).toBe(401)
    expect((await as(t, laptop)('GET', '/api/auth/me')).statusCode).toBe(200)
  })

  it('logs out', async () => {
    t = await createTestApp()
    const cookie = await login(t, 'a@example.cd')
    expect((await as(t, cookie)('POST', '/api/auth/logout', {})).statusCode).toBe(200)
    expect((await as(t, cookie)('GET', '/api/auth/me')).statusCode).toBe(401)
  })

  it('cannot revoke another user session', async () => {
    t = await createTestApp()
    const a = await login(t, 'a@example.cd')
    const b = await login(t, 'b@example.cd')
    const bSession = (await as(t, b)('GET', '/api/auth/sessions')).json().sessions[0].id
    expect((await as(t, a)('DELETE', `/api/auth/sessions/${bSession}`)).statusCode).toBe(404)
    expect((await as(t, b)('GET', '/api/auth/me')).statusCode).toBe(200)
  })
})
