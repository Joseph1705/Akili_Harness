import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'

export interface TestContext {
  app: FastifyInstance
  db: Db
  config: Config
  close(): Promise<void>
}

export const ORIGIN = 'http://localhost:3000'

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), 'akili-test-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    AKILI_DATA_DIR: dataDir,
    AKILI_MASTER_KEY: randomBytes(32).toString('base64'),
    AKILI_PUBLIC_ORIGIN: ORIGIN,
    AKILI_DEMO: '1',
    ...overrides,
  })
  const db = openDb(join(dataDir, 'akili.db'))
  const app = await buildApp({ config, db })
  await app.ready()
  return {
    app, db, config,
    async close() {
      await app.close()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
