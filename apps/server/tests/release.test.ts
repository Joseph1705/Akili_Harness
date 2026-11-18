/** What a person installing or updating the product relies on: a complete settings template, and one version number. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '../src/routes.js'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/** `NAME=value` lines, and `# NAME=value` lines for optional settings documented but switched off. */
function documented(): Map<string, string> {
  const vars = new Map<string, string>()
  for (const line of read('.env.example').split(/\r?\n/)) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) vars.set(m[1]!, m[2]!.trim())
  }
  return vars
}

/** Set by docker-compose.yml or the Dockerfile, never by the person filling in .env. */
const SET_BY_DOCKER = ['NODE_ENV', 'HOST', 'PORT', 'DATABASE_URL', 'AKILI_DATA_DIR', 'AKILI_WEB_DIST']
/** Addresses overridable only so tests can talk to local fake servers (config.ts). */
const TEST_ONLY = ['GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_USERINFO_URL', 'GOOGLE_REVOKE_URL', 'GOOGLE_GMAIL_BASE', 'GOOGLE_SHEETS_BASE', 'WHATSAPP_GRAPH_BASE']

describe('settings template for a new server (.env.example)', () => {
  it('is kept in git, since the deployment guide starts by copying it', () => {
    const ignored = spawnSync('git', ['check-ignore', '-q', '.env.example'], { cwd: root })
    expect(ignored.status).toBe(1)
    expect(read('.env.example').length).toBeGreaterThan(0)
  })

  it('documents every setting the server and docker-compose read', () => {
    const names = new Set([
      ...[...read('apps/server/src/config.ts').matchAll(/env(?:\.|, ')([A-Z][A-Z0-9_]+)/g)].map(m => m[1]!),
      ...[...read('docker-compose.yml').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(m => m[1]!),
    ])
    const vars = documented()
    const missing = [...names].filter(n => !vars.has(n) && !SET_BY_DOCKER.includes(n) && !TEST_ONLY.includes(n))
    expect(missing).toEqual([])
    const docker = read('docker-compose.yml') + read('Dockerfile')
    expect(SET_BY_DOCKER.filter(n => !docker.includes(n))).toEqual([])
  })

  it('leaves every secret blank', () => {
    const filled = [...documented()].filter(([name, value]) => /KEY|SECRET|PASSWORD|TOKEN/.test(name) && value !== '').map(([name]) => name)
    expect(filled).toEqual([])
  })
})

describe('release version', () => {
  it('is the same in the app, its packages and the changelog', () => {
    const version = (path: string) => (JSON.parse(read(path)) as { version: string }).version
    expect(version('apps/server/package.json')).toBe(APP_VERSION)
    expect(version('apps/web/package.json')).toBe(APP_VERSION)
    expect(read('CHANGELOG.md')).toContain(`## ${APP_VERSION}`)
  })
})
