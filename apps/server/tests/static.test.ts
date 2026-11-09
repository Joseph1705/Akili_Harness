import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('web interface serving', () => {
  it('serves files added after start, 404s missing assets, and falls back to the app for page routes', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'akili-dist-'))
    mkdirSync(join(dist, 'assets'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>')
    t = await createTestApp({ AKILI_WEB_DIST: dist })
    writeFileSync(join(dist, 'assets', 'index-new.js'), 'console.log(1)')
    const js = await t.app.inject({ method: 'GET', url: '/assets/index-new.js' })
    expect(js.statusCode).toBe(200)
    expect(js.headers['content-type']).toMatch(/javascript/)
    const missing = await t.app.inject({ method: 'GET', url: '/assets/index-old.js' })
    expect(missing.statusCode).toBe(404)
    const page = await t.app.inject({ method: 'GET', url: '/validations/abc' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toMatch(/text\/html/)
  })
})
