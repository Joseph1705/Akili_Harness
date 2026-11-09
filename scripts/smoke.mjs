#!/usr/bin/env node
// Keyless end-to-end check of the akili-credits gate inside the pinned DeepSeek Harness.
// Run after every dsh version change (rule 3): `pnpm smoke`. Needs a built dsh, no API key.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'akili-smoke-'))
const ledger = join(work, 'credits.jsonl')
const base = { ...process.env, DSH_HOME: join(work, 'dsh-home'), AKILI_LEDGER: ledger, AKILI_ORG_ID: 'org-fictive' }
delete base.DEEPSEEK_API_KEY
delete base.ANTHROPIC_API_KEY
delete base.AKILI_EXTERNAL_MODEL_CONSENT

function dshError(env) {
  const run = spawnSync('node', [join(root, 'scripts/dsh.mjs'), 'headless', 'Bonjour'], { env: { ...base, ...env }, encoding: 'utf8', timeout: 180_000 })
  const line = `${run.stdout}\n${run.stderr}`.split('\n').find(l => l.startsWith('dsh: '))
  return line ?? `(no dsh error line; exit ${run.status})\n${run.stderr.slice(-2000)}`
}

const cases = [
  { name: 'company plan refuses DeepSeek', env: { AKILI_PLAN: 'entreprise' }, expect: 'PLAN_ROUTE_FORBIDDEN' },
  { name: 'no call without consent', env: { AKILI_PLAN: 'solo' }, expect: 'EXTERNAL_MODEL_CONSENT_REQUIRED' },
  { name: 'no call without credits', env: { AKILI_PLAN: 'solo', AKILI_EXTERNAL_MODEL_CONSENT: 'oui' }, expect: 'CREDITS_EXHAUSTED' },
  {
    name: 'funded call reaches the DeepSeek adapter',
    before: () => spawnSync('node', ['--import', 'tsx', join(root, 'plugins/credits/scripts/credits.ts'), 'topup', 'org-fictive', '5', '--ref', 'FICTIF-SMOKE', '--ledger', ledger], { cwd: root, stdio: 'inherit' }),
    env: { AKILI_PLAN: 'solo', AKILI_EXTERNAL_MODEL_CONSENT: 'oui' },
    expect: 'MISSING_CREDENTIAL',
  },
]

let failed = 0
try {
  for (const c of cases) {
    c.before?.()
    const line = dshError(c.env)
    const ok = line.includes(c.expect)
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ${line}`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(failed === 0 ? `\n${cases.length} passed` : `\n${failed} of ${cases.length} failed`)
process.exit(failed === 0 ? 0 : 1)
