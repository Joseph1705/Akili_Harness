#!/usr/bin/env node
// Launch DeepSeek Harness with the Akili overlay.
//   node scripts/dsh.mjs [web|tui|...] [extra dsh args]
// Writes .akili/overlay.yml (absolute plugin paths, git-ignored) and runs the pinned dsh from source with this
// Node, exactly as dsh's own `pnpm dsh` script does (`node --import tsx/esm apps/cli/src/bin.ts`). Spawning
// `pnpm` instead fails on Windows, where it is a .cmd file that Node cannot start without a shell, and a shell
// would read the prompt text as a command line.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dsh = join(root, 'vendor', 'deepseek-harness')
const overlay = join(root, '.akili', 'overlay.yml')

const template = readFileSync(join(root, 'config', 'akili.patch.yml'), 'utf8')
mkdirSync(dirname(overlay), { recursive: true })
writeFileSync(overlay, template.replaceAll('__AKILI_ROOT__', root))

// dsh reads launcher flags after the profile name; what follows goes to the app.
const [profile = 'web', ...appArgs] = process.argv.slice(2)
// No session telemetry to DeepSeek's collector (rules 4 and 5); dsh treats any value as opt-out.
const env = { ...process.env, DSH_TELEMETRY_DISABLED: '1' }
const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', profile, '--patch', overlay, ...appArgs], { cwd: dsh, stdio: 'inherit', env })
if (result.error) console.error(`akili: impossible de lancer dsh : ${result.error.message}`)
process.exit(result.status ?? 1)
