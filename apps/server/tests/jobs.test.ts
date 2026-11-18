import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { openSafeZip, UnsafeArchive } from '../src/documents/zip-guard.js'
import { runOneJob, startWorker } from '../src/jobs.js'
import { createTestApp, readyOrg, type TestContext } from './helpers.js'

let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

async function uploadedDocument(o: Awaited<ReturnType<typeof readyOrg>>, name = 'Demande_facturation_Kalembe.txt'): Promise<string> {
  const res = await o.uploadDoc(name)
  expect(res.statusCode, res.body).toBe(200)
  return res.json().documents[0].id as string
}

describe('background jobs after a crash', () => {
  it('stops retrying a job that keeps crashing the server, and says no credit was used', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const crashing = await uploadedDocument(o)
    const unlucky = await uploadedDocument(o, 'Commande_Lualaba_BC-LM-0471.docx')
    // Both were being processed when the server stopped; the first has already used every attempt.
    await t.db.run("UPDATE jobs SET status = 'running', attempts = 3 WHERE ref_id = ?", crashing)
    await t.db.run("UPDATE jobs SET status = 'running', attempts = 1 WHERE ref_id = ?", unlucky)
    await t.db.run("UPDATE documents SET status = 'processing' WHERE id IN (?, ?)", crashing, unlucky)

    const worker = await startWorker(t.app, 60_000)
    worker.stop()

    const job = async (ref: string) => (await t!.db.get<{ status: string }>('SELECT status FROM jobs WHERE ref_id = ?', ref))!.status
    expect(await job(crashing)).toBe('failed')
    expect(await job(unlucky)).toBe('pending')
    const doc = (await o.call('GET', `/api/documents/${crashing}`)).json().document
    expect(doc.status).toBe('failed')
    expect(doc.error).toMatch(/Aucun crédit/)
  })

  it('never claims a job that has used every attempt', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const id = await uploadedDocument(o)
    await t.db.run("UPDATE jobs SET attempts = 3 WHERE ref_id = ?", id)
    expect(await runOneJob(t.app)).toBe(false)
  })
})

describe('Office archives that lie about their size', () => {
  it('are refused without being decompressed into memory', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', Buffer.alloc(100 * 1024 * 1024))
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
    // Declare 1 KB instead of 100 MB, in the local header and in the central directory.
    const name = Buffer.from('word/document.xml')
    for (let i = 0; i < bytes.length - 4; i++) {
      const sig = bytes.readUInt32LE(i)
      if (sig === 0x04034b50 && bytes.subarray(i + 30, i + 30 + name.length).equals(name)) bytes.writeUInt32LE(1024, i + 22)
      if (sig === 0x02014b50 && bytes.subarray(i + 46, i + 46 + name.length).equals(name)) bytes.writeUInt32LE(1024, i + 24)
    }
    const before = process.memoryUsage().rss
    await expect(openSafeZip(bytes)).rejects.toBeInstanceOf(UnsafeArchive)
    expect(process.memoryUsage().rss - before).toBeLessThan(50 * 1024 * 1024)
  })
})
