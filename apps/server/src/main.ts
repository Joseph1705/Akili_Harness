/** Entry point: `node --import tsx src/main.ts`. */
import { join } from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { startWorker } from './jobs.js'

const config = loadConfig(process.env)
const db = openDb(join(config.dataDir, 'akili.db'))
const app = await buildApp({ config, db })
const worker = startWorker(app)
await app.listen({ host: config.host, port: config.port })
console.log(`[akili] prêt sur ${config.publicOrigin}${config.demoMode ? ' (mode démo)' : ''}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    worker.stop()
    await app.close()
    db.close()
    process.exit(0)
  })
}
