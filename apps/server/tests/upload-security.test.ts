import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { drainJobs } from '../src/jobs.js'
import { readDocument, UnreadableDocument } from '../src/documents/extract.js'
import { sniff } from '../src/storage/sniff.js'
import { createTestApp, readyOrg, type TestContext } from './helpers.js'

let t: TestContext | undefined
let clamd: Server | undefined
afterEach(async () => {
  await t?.close(); t = undefined
  await new Promise<void>(r => (clamd ? clamd.close(() => r()) : r())); clamd = undefined
})

/** A local stand-in for clamd speaking its zINSTREAM protocol: "EICAR" in the stream is a virus. */
async function fakeClamd(): Promise<number> {
  clamd = createServer(socket => {
    let buf = Buffer.alloc(0)
    socket.on('data', d => {
      buf = Buffer.concat([buf, d])
      const start = buf.indexOf('zINSTREAM\0')
      if (start !== 0) return
      let off = 10
      const parts: Buffer[] = []
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off)
        if (len === 0) {
          const body = Buffer.concat(parts)
          socket.end(body.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0')
          return
        }
        if (off + 4 + len > buf.length) return
        parts.push(buf.subarray(off + 4, off + 4 + len))
        off += 4 + len
      }
    })
  })
  await new Promise<void>(r => clamd!.listen(0, '127.0.0.1', r))
  return (clamd.address() as AddressInfo).port
}

describe('antivirus on upload', () => {
  it('stores clean files and refuses infected ones before anything is saved', async () => {
    const port = await fakeClamd()
    t = await createTestApp({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port) })
    const o = await readyOrg(t)
    expect((await o.uploadDoc('Demande_facturation_Kalembe.txt')).statusCode).toBe(200)
    const infected = await o.send('facture.txt', Buffer.from('Client : X\nTotal : 10,00 USD\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n'))
    expect(infected.statusCode).toBe(400)
    expect(infected.json().message).toMatch(/antivirus/)
    expect((await o.call('GET', '/api/documents')).json().documents).toHaveLength(1)
    const audit = (await o.call('GET', '/api/audit')).json().entries.map((e: { action: string }) => e.action)
    expect(audit).toContain('document.virus_blocked')
  })

  it('refuses uploads when the configured antivirus does not answer (fails closed)', async () => {
    t = await createTestApp({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' })
    const o = await readyOrg(t)
    expect((await o.uploadDoc('Demande_facturation_Kalembe.txt')).statusCode).toBe(503)
  })
})

describe('hostile files', () => {
  it('refuses a Word file that would expand to gigabytes (zip bomb)', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', '<w:document><w:body>' + 'A'.repeat(80 * 1024 * 1024) + '</w:body></w:document>')
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
    expect(bomb.length).toBeLessThan(1024 * 1024)
    expect(sniff(bomb)).toBe('docx')
    await expect(readDocument(bomb, 'docx')).rejects.toBeInstanceOf(UnreadableDocument)
  })

  it('refuses programs, HTML and SVG whatever their name', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    for (const [name, bytes] of [
      ['facture.pdf', Buffer.from('MZ\x90\x00\x03\x00\x00\x00programme')],
      ['facture.txt', Buffer.from('<html><script>alert(1)</script></html>')],
      ['logo.jpg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ] as const) {
      expect((await o.send(name, bytes)).statusCode, name).toBe(400)
    }
  })

  it('does not charge for a corrupted PDF', async () => {
    t = await createTestApp()
    const o = await readyOrg(t, 'owner@example.cd', 2)
    await o.send('casse.pdf', Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> broken'))
    await drainJobs(t.app)
    const doc = (await o.call('GET', '/api/documents')).json().documents[0]
    expect(doc.status).toBe('failed')
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(2)
  })
})
