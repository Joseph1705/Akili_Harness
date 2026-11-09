/**
 * Database schema, versioned. Each migration runs once, in order, inside a transaction.
 * Every business table carries org_id; every query filters on it (directive 4.3).
 * Never edit a released migration: add a new one.
 */
import type { Db } from './db.js'

export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(email)),
    first_name text, last_name text, phone text,
    locale text NOT NULL DEFAULT 'fr',
    timezone text NOT NULL DEFAULT 'Africa/Lubumbashi',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE login_codes (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX login_codes_email ON login_codes (email, created_at DESC);

  CREATE TABLE organizations (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('company', 'individual')),
    name text NOT NULL,
    plan text NOT NULL CHECK (plan IN ('solo', 'entreprise')),
    data_mode text NOT NULL DEFAULT 'standard' CHECK (data_mode IN ('standard', 'souverain')),
    sector text, city text, province text,
    currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'CDF')),
    secondary_currencies text, team_size text,
    rccm text, id_nat text, nif text, address text,
    vat_status text NOT NULL DEFAULT 'unknown' CHECK (vat_status IN ('yes', 'no', 'unknown')),
    accounting_software text, reports_channel text, bank_details text,
    logo_blob_id uuid,
    onboarding_step integer NOT NULL DEFAULT 1,
    onboarding_done_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES users (id),
    current_org_id uuid REFERENCES organizations (id),
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  CREATE TABLE memberships (
    user_id uuid NOT NULL REFERENCES users (id),
    org_id uuid NOT NULL REFERENCES organizations (id),
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'reader', 'accountant')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, org_id)
  );
  CREATE INDEX memberships_org ON memberships (org_id);

  CREATE TABLE consents (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id uuid NOT NULL UNIQUE,
    org_id uuid NOT NULL REFERENCES organizations (id),
    user_id uuid NOT NULL REFERENCES users (id),
    type text NOT NULL CHECK (type IN ('terms', 'privacy', 'external_model')),
    version text NOT NULL,
    granted boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX consents_org ON consents (org_id, type, seq DESC);

  CREATE TABLE audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id uuid,
    user_id uuid,
    action text NOT NULL,
    target_type text, target_id text,
    detail jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX audit_org ON audit_log (org_id, id DESC);

  CREATE TABLE blobs (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    sha256 text NOT NULL,
    size integer NOT NULL,
    kind text NOT NULL,
    filename text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX blobs_hash ON blobs (org_id, sha256);

  CREATE TABLE credit_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    kind text NOT NULL CHECK (kind IN ('topup', 'consume', 'adjust')),
    amount integer NOT NULL,
    ref text NOT NULL,
    document_id uuid,
    user_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'topup' AND amount > 0) OR (kind = 'consume' AND amount < 0) OR kind = 'adjust')
  );
  CREATE INDEX credit_ledger_org ON credit_ledger (org_id, id DESC);
  CREATE UNIQUE INDEX credit_once_per_document ON credit_ledger (org_id, document_id) WHERE kind = 'consume';

  CREATE TABLE agents (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    pack_id text NOT NULL,
    name text NOT NULL,
    language text NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en', 'sw')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_action_at timestamptz
  );
  CREATE INDEX agents_org ON agents (org_id);

  CREATE TABLE clients (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    name text NOT NULL,
    address text, nif text, rccm text, email text,
    vat_applicable boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX clients_org ON clients (org_id);

  CREATE TABLE contracts (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    client_id uuid NOT NULL REFERENCES clients (id),
    reference text NOT NULL,
    po_number text NOT NULL,
    currency text NOT NULL CHECK (currency IN ('USD', 'CDF')),
    payment_terms_days integer NOT NULL CHECK (payment_terms_days BETWEEN 0 AND 365),
    rates jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX contracts_po ON contracts (org_id, upper(po_number));

  CREATE TABLE chat_sessions (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    user_id uuid NOT NULL REFERENCES users (id),
    agent_id uuid REFERENCES agents (id),
    title text NOT NULL,
    status text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX chat_sessions_org ON chat_sessions (org_id, updated_at DESC);

  CREATE TABLE chat_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id uuid NOT NULL,
    session_id uuid NOT NULL REFERENCES chat_sessions (id),
    role text NOT NULL CHECK (role IN ('user', 'agent', 'tool', 'system')),
    content jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX chat_events_session ON chat_events (session_id, id);

  CREATE TABLE documents (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    agent_id uuid NOT NULL REFERENCES agents (id),
    blob_id uuid NOT NULL REFERENCES blobs (id),
    filename text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('pdf', 'xlsx', 'csv')),
    status text NOT NULL CHECK (status IN ('queued', 'processing', 'waiting_credits', 'done', 'duplicate', 'failed')),
    report_number text,
    extracted jsonb,
    error text,
    invoice_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
  );
  CREATE INDEX documents_org ON documents (org_id, created_at DESC);
  CREATE INDEX documents_report ON documents (org_id, report_number);

  CREATE TABLE document_sessions (
    document_id uuid PRIMARY KEY REFERENCES documents (id),
    org_id uuid NOT NULL,
    session_id uuid NOT NULL REFERENCES chat_sessions (id)
  );
  CREATE INDEX document_sessions_session ON document_sessions (session_id);

  CREATE TABLE invoices (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations (id),
    document_id uuid NOT NULL REFERENCES documents (id),
    agent_id uuid NOT NULL REFERENCES agents (id),
    client_id uuid NOT NULL REFERENCES clients (id),
    contract_id uuid NOT NULL REFERENCES contracts (id),
    number text NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'validated', 'rejected')),
    currency text NOT NULL,
    lines jsonb NOT NULL,
    subtotal_cents bigint NOT NULL,
    vat_rate_bp integer NOT NULL,
    vat_cents bigint NOT NULL,
    total_cents bigint NOT NULL,
    issue_date date NOT NULL,
    due_date date NOT NULL,
    po_number text NOT NULL,
    period text,
    checks jsonb NOT NULL,
    decided_by uuid REFERENCES users (id),
    decided_at timestamptz,
    reject_reason text,
    corrections jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, number)
  );
  CREATE INDEX invoices_org_status ON invoices (org_id, status, created_at);

  CREATE TABLE invoice_counters (
    org_id uuid NOT NULL REFERENCES organizations (id),
    series text NOT NULL,
    year integer NOT NULL,
    next integer NOT NULL,
    PRIMARY KEY (org_id, series, year)
  );

  CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    type text NOT NULL,
    ref_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'waiting_credits', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    error text,
    run_after timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX jobs_pending ON jobs (status, run_after) WHERE status = 'pending';

  CREATE TABLE idempotency (
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    key uuid NOT NULL,
    body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id, key)
  );
  `,
  },
]

export async function migrate(db: Db): Promise<void> {
  await db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
  await db.tx(async tx => {
    // One migrator at a time, even with several app containers starting together.
    await tx.run('SELECT pg_advisory_xact_lock(4242424242)')
    const done = new Set((await tx.all<{ version: number }>('SELECT version FROM schema_migrations')).map(r => r.version))
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue
      await tx.run(m.sql)
      await tx.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', m.version, m.name)
    }
  })
}
