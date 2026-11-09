/** Entry point. Development: `node --import tsx src/main.ts`. Production (Docker): `node dist/main.js`. */
import { mkdirSync } from 'node:fs'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { startWorker } from './jobs.js'

const config = loadConfig(process.env)
mkdirSync(config.dataDir, { recursive: true })
const db = await openDb(config.databaseUrl)
const app = await buildApp({ config, db })
const worker = await startWorker(app)
await app.listen({ host: config.host, port: config.port })
app.log.info(`prêt sur ${config.publicOrigin} (${config.env})${config.smtp ? '' : ' — e-mails dans la console'}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    worker.stop()
    await app.close()
    await db.close()
    process.exit(0)
  })
}
