/**
 * Prepaid credit ledger, append-only.
 *
 * Every movement is one JSON line in the journal file: top-ups (`topup`),
 * model-call charges (`charge`) and manual corrections (`adjust`). The balance is
 * the sum of the journal; nothing is ever rewritten, which keeps the journal usable
 * as the audit trail of the billing.
 *
 * Prototype scope: one process writes the file. The multi-organization version
 * (PostgreSQL, row-level security, phase 1) keeps the same entry shape.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LedgerEntryKind = 'topup' | 'charge' | 'adjust'

export interface LedgerEntry {
  /** ISO timestamp. */
  at: string
  orgId: string
  kind: LedgerEntryKind
  /** Signed milli-credits: positive for top-ups, negative for charges. */
  milliCredits: number
  /** Payment reference, model route, or reason of the correction. */
  ref: string
  /** Token counts and the price source, for charges. */
  detail?: Record<string, unknown>
}

export interface CreditLedger {
  balance(orgId: string): Promise<number>
  record(entry: Omit<LedgerEntry, 'at'>): Promise<LedgerEntry>
  entries(orgId: string): Promise<LedgerEntry[]>
}

function validate(entry: Omit<LedgerEntry, 'at'>): void {
  if (!entry.orgId) throw new Error('ledger: orgId is required')
  if (!Number.isInteger(entry.milliCredits)) throw new Error('ledger: milliCredits must be an integer')
  if (entry.kind === 'topup' && entry.milliCredits <= 0) throw new Error('ledger: a top-up must be positive')
  if (entry.kind === 'charge' && entry.milliCredits > 0) throw new Error('ledger: a charge must be negative or zero')
  if (!entry.ref) throw new Error('ledger: ref is required')
}

/** In-memory ledger for tests. */
export class MemoryLedger implements CreditLedger {
  private readonly journal: LedgerEntry[] = []
  constructor(private readonly now: () => Date = () => new Date()) {}

  async balance(orgId: string): Promise<number> {
    return this.journal.filter(e => e.orgId === orgId).reduce((sum, e) => sum + e.milliCredits, 0)
  }

  async record(entry: Omit<LedgerEntry, 'at'>): Promise<LedgerEntry> {
    validate(entry)
    const full = { at: this.now().toISOString(), ...entry }
    this.journal.push(full)
    return full
  }

  async entries(orgId: string): Promise<LedgerEntry[]> {
    return this.journal.filter(e => e.orgId === orgId)
  }
}

/** JSON-lines ledger on disk. Writes are serialized inside the process. */
export class FileLedger implements CreditLedger {
  private cache: LedgerEntry[] | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  private async load(): Promise<LedgerEntry[]> {
    if (this.cache) return this.cache
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.cache = text.split('\n').filter(line => line.trim() !== '').map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEntry
      } catch {
        throw new Error(`ledger: line ${index + 1} of ${this.path} is not valid JSON; refusing to guess the balance`)
      }
    })
    return this.cache
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  balance(orgId: string): Promise<number> {
    return this.serialize(async () => (await this.load())
      .filter(e => e.orgId === orgId)
      .reduce((sum, e) => sum + e.milliCredits, 0))
  }

  record(entry: Omit<LedgerEntry, 'at'>): Promise<LedgerEntry> {
    validate(entry)
    return this.serialize(async () => {
      const journal = await this.load()
      const full = { at: this.now().toISOString(), ...entry }
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(full)}\n`, { encoding: 'utf8', flush: true })
      journal.push(full)
      return full
    })
  }

  entries(orgId: string): Promise<LedgerEntry[]> {
    return this.serialize(async () => (await this.load()).filter(e => e.orgId === orgId))
  }
}
