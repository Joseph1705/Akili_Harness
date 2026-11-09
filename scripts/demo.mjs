#!/usr/bin/env node
// One command for the presentation: build the interface, fill a fictitious company, start the server.
//   pnpm demo            → http://localhost:3000
//   pnpm demo --reset    → start again from an empty demo database
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = join(root, 'data', 'demo')
const port = process.env.PORT ?? '3000'
const env = {
  ...process.env, NODE_ENV: 'development', AKILI_DEMO: '1', AKILI_DATA_DIR: dataDir, PORT: port,
  AKILI_PUBLIC_ORIGIN: process.env.AKILI_PUBLIC_ORIGIN ?? `http://localhost:${port}`,
  AKILI_WEB_DIST: join(root, 'apps', 'web', 'dist'),
}
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (process.argv.includes('--reset')) rmSync(dataDir, { recursive: true, force: true })
if (!existsSync(join(root, 'apps', 'web', 'dist', 'index.html')) || process.argv.includes('--build')) run('pnpm', ['--filter', '@akili/web', 'build'])
run('node', ['--import', 'tsx', 'apps/server/scripts/seed-demo.ts'], root)
console.log(`\n  Ouvrez http://localhost:${port}`)
console.log('  Connexion : mireille.kabange@kibala.example (le code s\'affiche à l\'écran en mode démo)\n')
const server = spawn('node', ['--import', 'tsx', 'apps/server/src/main.ts'], { cwd: root, env, stdio: 'inherit' })
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.kill(s))
server.on('exit', code => process.exit(code ?? 0))
