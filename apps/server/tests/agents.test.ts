import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { drainJobs } from '../src/jobs.js'
import { createTestApp, multipart, onboardedOwner, ORIGIN, readyOrg, type TestContext } from './helpers.js'

const dir = resolve(import.meta.dirname, '../../../fixtures/reports')
let t: TestContext | undefined
afterEach(async () => { await t?.close(); t = undefined })

describe('packs and agents', () => {
  it('lists packs and only creates agents from available ones', async () => {
    t = await createTestApp()
    const { call } = await onboardedOwner(t, 'a@example.cd')
    const packs = (await call('GET', '/api/packs')).json().packs
    expect(packs.find((p: { id: string }) => p.id === 'facturation-sous-traitance').available).toBe(true)
    expect((await call('POST', '/api/agents', { packId: 'paie-cnss', name: 'Paie' })).statusCode).toBe(400)
    expect((await call('POST', '/api/agents', { packId: 'facturation-sous-traitance', name: 'Agent Facturation' })).statusCode).toBe(200)
  })

  it('tests an agent on sample reports without charging credits or creating invoices', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const files = ['RA-2026-10-014_Tshala_Kipushi.pdf', 'RA-2026-10-031_Kalembe_Anomalies.pdf']
    const parts = files.map(f => ({ name: f, bytes: readFileSync(join(dir, f)) }))
    const boundary = '----akilitest'
    const body = Buffer.concat([...parts.flatMap(p => [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${p.name}"\r\nContent-Type: application/pdf\r\n\r\n`), p.bytes, Buffer.from('\r\n')]),
      Buffer.from(`--${boundary}--\r\n`)])
    const res = await t.app.inject({ method: 'POST', url: `/api/agents/${o.agent.id}/test`, headers: { origin: ORIGIN, cookie: o.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body })
    expect(res.statusCode).toBe(200)
    const results = res.json().results
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ ok: true, report: 'RA-2026-10-014', total_cents: 1480160 })
    expect(results[1].attention).toBeGreaterThan(0)
    expect((await o.call('GET', '/api/credits')).json().balance).toBe(20)
    expect((await o.call('GET', '/api/invoices')).json().invoices).toHaveLength(0)
  })
})

describe('dashboard and sessions', () => {
  it('summarizes the day: agents, documents, validations waiting', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    await o.upload('RA-2026-10-014_Tshala_Kipushi.pdf')
    await o.upload('RA-2026-10-021_Kalembe_Forage.pdf')
    await drainJobs(t.app)
    const d = (await o.call('GET', '/api/dashboard')).json()
    expect(d.agents).toMatchObject({ active: 1, total: 1 })
    expect(d.documentsToday.done).toBe(2)
    expect(d.pending.count).toBe(2)
    expect(d.pending.items[0]).toMatchObject({ client_name: 'Tshala Logistique SARL', total_cents: 1480160 })
    expect(d.credits).toBe(18)
  })

  it('writes singular and plural correctly in the transcript', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const sessionId = (await o.upload('RA-2026-10-031_Kalembe_Anomalies.pdf')).json().sessionId
    await drainJobs(t.app)
    const s = (await o.call('GET', `/api/sessions/${sessionId}`)).json()
    const calc = s.events.find((e: { content: { name?: string } }) => e.content.name === 'Calculer')
    expect(calc.content.arg).toBe('1 ligne · TVA 16 %')
  })

  it('keeps the agent steps in the session transcript', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const sessionId = (await o.upload('RA-2026-10-014_Tshala_Kipushi.pdf')).json().sessionId
    await drainJobs(t.app)
    const s = (await o.call('GET', `/api/sessions/${sessionId}`)).json()
    const tools = s.events.filter((e: { role: string }) => e.role === 'tool').map((e: { content: { name: string } }) => e.content.name)
    expect(tools).toEqual(['Lire', 'Rapprocher', 'Calculer', 'Préparer'])
    const calc = s.events.find((e: { content: { name?: string } }) => e.content.name === 'Calculer')
    expect(calc.content.arg).toBe('3 lignes · TVA 16 %')
    expect((await o.call('GET', '/api/sessions')).json().sessions[0].id).toBe(sessionId)
  })

  it('answers commands, and says plainly when no model is configured', async () => {
    t = await createTestApp()
    const o = await readyOrg(t)
    const sid = (await o.call('POST', '/api/sessions', { title: 'Questions' })).json().session.id
    const solde = (await o.call('POST', `/api/sessions/${sid}/messages`, { text: '/solde' })).json()
    expect(solde.reply.text).toContain('20 crédits')
    const free = (await o.call('POST', `/api/sessions/${sid}/messages`, { text: 'Combien ai-je facturé à Tshala ?' })).json()
    expect(free.reply.text).toMatch(/modèle/)
    expect((await o.call('POST', `/api/sessions/${sid}/messages`, { text: '' })).statusCode).toBe(400)
  })
})
