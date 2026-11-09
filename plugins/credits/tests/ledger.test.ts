import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileLedger, MemoryLedger } from '../src/ledger.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'akili-ledger-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('ledger', () => {
  it('sums top-ups and charges per organization', async () => {
    const ledger = new MemoryLedger()
    await ledger.record({ orgId: 'a', kind: 'topup', milliCredits: 5000, ref: 'pay-1' })
    await ledger.record({ orgId: 'a', kind: 'charge', milliCredits: -1200, ref: 'anthropic/claude-opus-5-5' })
    await ledger.record({ orgId: 'b', kind: 'topup', milliCredits: 1000, ref: 'pay-2' })
    expect(await ledger.balance('a')).toBe(3800)
    expect(await ledger.balance('b')).toBe(1000)
  })

  it('refuses malformed entries', async () => {
    const ledger = new MemoryLedger()
    await expect(ledger.record({ orgId: 'a', kind: 'topup', milliCredits: -1, ref: 'x' })).rejects.toThrow()
    await expect(ledger.record({ orgId: 'a', kind: 'charge', milliCredits: 10, ref: 'x' })).rejects.toThrow()
    await expect(ledger.record({ orgId: 'a', kind: 'topup', milliCredits: 1, ref: '' })).rejects.toThrow()
  })

  it('persists to an append-only file and reloads it', async () => {
    const path = join(dir, 'nested', 'credits.jsonl')
    const first = new FileLedger(path)
    await first.record({ orgId: 'a', kind: 'topup', milliCredits: 2000, ref: 'pay-1' })
    await Promise.all([1, 2, 3].map(i => first.record({ orgId: 'a', kind: 'charge', milliCredits: -100, ref: `call-${i}` })))
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(await new FileLedger(path).balance('a')).toBe(1700)
  })

  it('refuses to guess a balance from a corrupted journal', async () => {
    const path = join(dir, 'credits.jsonl')
    await writeFile(path, '{"orgId":"a","kind":"topup","milliCredits":10,"ref":"x"}\nnot json\n')
    await expect(new FileLedger(path).balance('a')).rejects.toThrow(/line 2/)
  })
})
