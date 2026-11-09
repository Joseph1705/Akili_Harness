import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { orgKey } from '../src/security/crypto.js'
import { getBlob, putBlob } from '../src/storage/blobs.js'
import { sniff } from '../src/storage/sniff.js'
import { createTestApp, type TestContext } from './helpers.js'
import { createOrg } from './fixtures.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

function findFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? findFiles(join(dir, e.name)) : [join(dir, e.name)])
}

describe('encrypted blob storage', () => {
  it('derives a different key per organization', () => {
    const master = Buffer.alloc(32, 7)
    expect(orgKey(master, 'a').equals(orgKey(master, 'b'))).toBe(false)
    expect(orgKey(master, 'a').equals(orgKey(master, 'a'))).toBe(true)
  })

  it('round-trips bytes and never stores them in clear', async () => {
    t = await createTestApp()
    const org = createOrg(t.db)
    const secret = Buffer.from('%PDF-1.7 Rapport confidentiel FICTIF 12345')
    const blob = putBlob(t.db, t.config, org, secret, { filename: 'r.pdf', kind: 'pdf' })
    expect(getBlob(t.db, t.config, org, blob.id).bytes.equals(secret)).toBe(true)
    const files = findFiles(join(t.config.dataDir, 'blobs'))
    expect(files).toHaveLength(1)
    expect(readFileSync(files[0]!).includes(Buffer.from('confidentiel'))).toBe(false)
  })

  it('refuses to read another organization blob', async () => {
    t = await createTestApp()
    const a = createOrg(t.db, 'A')
    const b = createOrg(t.db, 'B')
    const blob = putBlob(t.db, t.config, a, Buffer.from('x'), { filename: 'x.csv', kind: 'csv' })
    expect(() => getBlob(t!.db, t!.config, b, blob.id)).toThrow(/introuvable/)
  })
})

describe('file type detection', () => {
  it('recognizes supported types by their bytes', () => {
    expect(sniff(Buffer.from('%PDF-1.4\n...'))).toBe('pdf')
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png')
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('jpeg')
    expect(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniff(Buffer.from('code;designation;unite;quantite\nGRU-25;Grue;jour;12\n'))).toBe('csv')
  })

  it('recognizes an xlsx only when the zip holds a workbook', () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('[Content_Types].xml xl/workbook.xml')])
    expect(sniff(zip)).toBe('xlsx')
    const otherZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('evil.exe')])
    expect(sniff(otherZip)).toBeNull()
  })

  it('refuses an executable renamed .pdf and binary garbage', () => {
    expect(sniff(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull()
    expect(sniff(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toBeNull()
    expect(sniff(Buffer.from('<svg onload="alert(1)"></svg>'))).toBeNull()
  })
})
