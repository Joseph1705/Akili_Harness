/** Organization files, encrypted on disk under <dataDir>/blobs/<org>/<id>. Metadata in the `blobs` table. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Config } from '../config.js'
import { now, type Db } from '../db.js'
import { notFound } from '../errors.js'
import { decrypt, encrypt, orgKey, sha256 } from '../security/crypto.js'
import type { FileKind } from './sniff.js'

export interface Blob {
  id: string
  org_id: string
  sha256: string
  size: number
  kind: FileKind
  filename: string
  created_at: string
}

/** Keep a readable, harmless name: letters, digits, dot, dash, underscore; at most 120 chars. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'fichier'
  const cleaned = base.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '')
  return (cleaned || 'fichier').slice(0, 120)
}

function pathFor(config: Config, orgId: string, id: string): string {
  return join(config.dataDir, 'blobs', orgId, id)
}

export function putBlob(db: Db, config: Config, orgId: string, bytes: Buffer, meta: { filename: string; kind: FileKind }): Blob {
  const blob: Blob = {
    id: randomUUID(), org_id: orgId, sha256: sha256(bytes), size: bytes.length,
    kind: meta.kind, filename: safeFilename(meta.filename), created_at: now(),
  }
  const path = pathFor(config, orgId, blob.id)
  mkdirSync(join(config.dataDir, 'blobs', orgId), { recursive: true, mode: 0o700 })
  writeFileSync(path, encrypt(orgKey(config.masterKey, orgId), bytes, `${orgId}/${blob.id}`), { mode: 0o600 })
  db.prepare('INSERT INTO blobs (id, org_id, sha256, size, kind, filename, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(blob.id, blob.org_id, blob.sha256, blob.size, blob.kind, blob.filename, blob.created_at)
  return blob
}

export function getBlob(db: Db, config: Config, orgId: string, id: string): { blob: Blob; bytes: Buffer } {
  const blob = db.prepare('SELECT * FROM blobs WHERE id = ? AND org_id = ?').get(id, orgId) as Blob | undefined
  if (!blob) throw notFound('Fichier')
  const bytes = decrypt(orgKey(config.masterKey, orgId), readFileSync(pathFor(config, orgId, id)), `${orgId}/${id}`)
  return { blob, bytes }
}
