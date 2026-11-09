/** Schema. Every business table carries org_id; every query filters on it (directive 4.3). */
import type { DatabaseSync } from 'node:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, first_name TEXT, last_name TEXT, phone TEXT,
    locale TEXT NOT NULL DEFAULT 'fr', timezone TEXT NOT NULL DEFAULT 'Africa/Lubumbashi', created_at TEXT NOT NULL
  );
  CREATE TABLE login_codes (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, consumed_at TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX login_codes_email ON login_codes(email, created_at);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
    current_org_id TEXT, user_agent TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, revoked_at TEXT
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('company','individual')), name TEXT NOT NULL,
    plan TEXT NOT NULL CHECK (plan IN ('solo','entreprise')),
    data_mode TEXT NOT NULL DEFAULT 'standard' CHECK (data_mode IN ('standard','souverain')),
    sector TEXT, city TEXT, province TEXT, currency TEXT NOT NULL DEFAULT 'USD', secondary_currencies TEXT,
    team_size TEXT, rccm TEXT, id_nat TEXT, nif TEXT, address TEXT,
    vat_status TEXT NOT NULL DEFAULT 'unknown' CHECK (vat_status IN ('yes','no','unknown')),
    accounting_software TEXT, reports_channel TEXT, bank_details TEXT,
    logo_blob_id TEXT, onboarding_step INTEGER NOT NULL DEFAULT 1, onboarding_done_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE memberships (
    user_id TEXT NOT NULL REFERENCES users(id), org_id TEXT NOT NULL REFERENCES organizations(id),
    role TEXT NOT NULL CHECK (role IN ('owner','admin','operator','reader','accountant')),
    created_at TEXT NOT NULL, PRIMARY KEY (user_id, org_id)
  );
  CREATE TABLE consents (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL,
    type TEXT NOT NULL, version TEXT NOT NULL, granted INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, user_id TEXT, action TEXT NOT NULL,
    target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX audit_org ON audit_log(org_id, id);
  CREATE TABLE blobs (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), sha256 TEXT NOT NULL,
    size INTEGER NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL REFERENCES organizations(id),
    kind TEXT NOT NULL CHECK (kind IN ('topup','consume','adjust')), amount INTEGER NOT NULL,
    ref TEXT NOT NULL, document_id TEXT, user_id TEXT, created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX credit_once_per_document ON credit_ledger(org_id, document_id) WHERE kind = 'consume';
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), pack_id TEXT NOT NULL,
    name TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'fr', status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, last_action_at TEXT
  );
  CREATE TABLE clients (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
    address TEXT, nif TEXT, rccm TEXT, email TEXT, vat_applicable INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE contracts (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), client_id TEXT NOT NULL REFERENCES clients(id),
    reference TEXT NOT NULL, po_number TEXT NOT NULL, currency TEXT NOT NULL, payment_terms_days INTEGER NOT NULL,
    rates TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE documents (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), agent_id TEXT NOT NULL REFERENCES agents(id),
    blob_id TEXT NOT NULL REFERENCES blobs(id), filename TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','processing','waiting_credits','done','duplicate','failed')),
    report_number TEXT, extracted TEXT, error TEXT, invoice_id TEXT, created_at TEXT NOT NULL, processed_at TEXT
  );
  CREATE INDEX documents_org ON documents(org_id, created_at);
  CREATE TABLE invoices (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), document_id TEXT NOT NULL REFERENCES documents(id),
    agent_id TEXT NOT NULL, client_id TEXT NOT NULL, contract_id TEXT NOT NULL, number TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','validated','rejected')), currency TEXT NOT NULL,
    lines TEXT NOT NULL, subtotal_cents INTEGER NOT NULL, vat_rate_bp INTEGER NOT NULL, vat_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL, po_number TEXT NOT NULL,
    period TEXT, checks TEXT NOT NULL, decided_by TEXT, decided_at TEXT, reject_reason TEXT, corrections TEXT,
    created_at TEXT NOT NULL, UNIQUE (org_id, number)
  );
  CREATE TABLE invoice_counters (org_id TEXT NOT NULL, year INTEGER NOT NULL, next INTEGER NOT NULL, PRIMARY KEY (org_id, year));
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, type TEXT NOT NULL, ref_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
    run_after TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE idempotency (
    key TEXT NOT NULL, org_id TEXT NOT NULL, user_id TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id, key)
  );
  CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL,
    agent_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE chat_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES chat_sessions(id),
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE document_sessions (
    document_id TEXT PRIMARY KEY REFERENCES documents(id), org_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES chat_sessions(id)
  );
  CREATE INDEX documents_hash ON blobs(org_id, sha256);
  `,
]

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  let version = row?.version ?? 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version]!)
      version++
      db.prepare('UPDATE schema_version SET version = ?').run(version)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
