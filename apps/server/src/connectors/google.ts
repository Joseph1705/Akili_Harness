/**
 * Google connector (DIRECTIVES §3 D): OAuth 2.0 authorization code flow with PKCE (S256) and a one-time
 * `state` bound to the user who started it; tokens encrypted with the organization's key; refresh on expiry;
 * revocation on disconnect. Gmail (read, send), Sheets (append rows); Drive is declared for later.
 * Sending and writing are outbound actions: a person triggers them, or approves an agent's proposal (rule 7).
 */
import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Db } from '../db.js'
import { HttpError, notFound } from '../errors.js'
import { hmac } from '../security/crypto.js'
import { openSecret, sealSecret } from '../security/secrets.js'

export const GOOGLE_SERVICES = {
  gmail_read: { label: 'Lire les e-mails (Gmail)', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], available: true },
  gmail_send: { label: 'Envoyer des e-mails (Gmail)', scopes: ['https://www.googleapis.com/auth/gmail.send'], available: true },
  sheets: { label: 'Google Sheets (ajouter des lignes)', scopes: ['https://www.googleapis.com/auth/spreadsheets'], available: true },
  drive: { label: 'Google Drive — bientôt', scopes: ['https://www.googleapis.com/auth/drive.file'], available: false },
} as const
export type GoogleService = keyof typeof GOOGLE_SERVICES

interface Tokens { access_token: string; refresh_token: string | null; expires_at: number }

export class ConnectorError extends HttpError {
  constructor(message: string, status = 502) { super(status, 'connector_error', message) }
}

function googleConfig(app: FastifyInstance) {
  const cfg = app.deps.config.connectors.google
  if (!cfg) throw new HttpError(503, 'connector_unavailable', "La connexion Google n'est pas configurée sur ce serveur (identifiants OAuth manquants).")
  return cfg
}

const redirectUri = (app: FastifyInstance) => `${app.deps.config.publicOrigin}/api/connectors/google/callback`
const stateKey = (app: FastifyInstance) => Buffer.from(hmac(app.deps.config.masterKey, 'oauth-state-key-v1'), 'hex')

export async function startGoogle(app: FastifyInstance, orgId: string, userId: string, services: GoogleService[]): Promise<string> {
  const cfg = googleConfig(app)
  const { db, config } = app.deps
  const wanted = services.filter(s => GOOGLE_SERVICES[s]?.available)
  if (wanted.length === 0) throw new HttpError(400, 'bad_request', 'Choisissez au moins un service Google.')
  const scopes = ['openid', 'email', ...wanted.flatMap(s => GOOGLE_SERVICES[s].scopes)]
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  await db.run(`INSERT INTO oauth_states (state_hash, org_id, user_id, provider, verifier, scopes, expires_at)
    VALUES (?, ?, ?, 'google', ?, ?, now() + interval '10 minutes')`,
  hmac(stateKey(app), state), orgId, userId, sealSecret(config, orgId, 'oauth-verifier', verifier), scopes)
  const params = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirectUri(app), response_type: 'code', scope: scopes.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256',
  })
  return `${cfg.authUrl}?${params.toString()}`
}

async function tokenRequest(app: FastifyInstance, form: Record<string, string>): Promise<Record<string, unknown>> {
  const cfg = googleConfig(app)
  let res: Response
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }).toString(),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    })
  } catch {
    throw new ConnectorError('Google est injoignable. Réessayez dans quelques minutes.')
  }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new ConnectorError(res.status === 400 ? "Google a refusé l'autorisation (code expiré ou déjà utilisé)." : `Erreur Google (${res.status}).`)
  return body
}

/** The browser comes back from Google's consent screen. */
export async function finishGoogle(app: FastifyInstance, userId: string, query: { state?: string; code?: string; error?: string }): Promise<{ orgId: string; account: string }> {
  const { db, config } = app.deps
  if (!query.state) throw new HttpError(400, 'bad_request', 'Réponse Google incomplète.')
  const row = await db.get<{ org_id: string; user_id: string; verifier: Buffer; scopes: string[] }>(`UPDATE oauth_states SET used_at = now()
    WHERE state_hash = ? AND provider = 'google' AND used_at IS NULL AND expires_at > now() RETURNING org_id, user_id, verifier, scopes`, hmac(stateKey(app), query.state))
  if (!row) throw new HttpError(400, 'bad_request', 'Demande de connexion expirée ou déjà utilisée. Recommencez depuis les paramètres.')
  // The callback must come back to the person who started it (protects against login CSRF).
  if (row.user_id !== userId) throw new HttpError(403, 'forbidden', 'Cette autorisation a été demandée par une autre personne.')
  if (query.error || !query.code) throw new HttpError(400, 'bad_request', 'Autorisation Google refusée.')
  const verifier = openSecret<string>(config, row.org_id, 'oauth-verifier', row.verifier)
  const token = await tokenRequest(app, { code: query.code, redirect_uri: redirectUri(app), grant_type: 'authorization_code', code_verifier: verifier })
  if (typeof token.access_token !== 'string') throw new ConnectorError('Réponse Google invalide.')
  const granted = typeof token.scope === 'string' ? token.scope.split(' ') : row.scopes
  const account = await userinfo(app, token.access_token)
  const tokens: Tokens = { access_token: token.access_token, refresh_token: typeof token.refresh_token === 'string' ? token.refresh_token : null, expires_at: Date.now() + Number(token.expires_in ?? 3600) * 1000 }
  const id = randomUUID()
  await db.tx(async tx => {
    await tx.run("UPDATE connections SET status = 'revoked', secrets = NULL, updated_at = now() WHERE org_id = ? AND provider = 'google' AND status <> 'revoked'", row.org_id)
    await tx.run(`INSERT INTO connections (id, org_id, provider, status, account, scopes, secrets, created_by) VALUES (?, ?, 'google', 'connected', ?, ?, ?, ?)`,
      id, row.org_id, account, granted, sealSecret(config, row.org_id, `connection:${id}`, tokens), userId)
  })
  return { orgId: row.org_id, account }
}

async function userinfo(app: FastifyInstance, accessToken: string): Promise<string> {
  const cfg = googleConfig(app)
  const res = await fetch(cfg.userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' }).catch(() => null)
  const body = res?.ok ? await res.json().catch(() => ({})) as { email?: string } : {}
  return typeof body.email === 'string' ? body.email.slice(0, 254) : 'compte Google'
}

interface ConnectionRow { id: string; secrets: Buffer | null; scopes: string[]; account: string | null }

async function connection(db: Db, orgId: string): Promise<ConnectionRow> {
  const row = await db.get<ConnectionRow>("SELECT id, secrets, scopes, account FROM connections WHERE org_id = ? AND provider = 'google' AND status = 'connected'", orgId)
  if (!row || !row.secrets) throw new HttpError(409, 'not_connected', "Google n'est pas connecté pour votre organisation.")
  return row
}

export async function googleScopes(db: Db, orgId: string): Promise<string[] | null> {
  const row = await db.get<{ scopes: string[] }>("SELECT scopes FROM connections WHERE org_id = ? AND provider = 'google' AND status = 'connected'", orgId)
  return row?.scopes ?? null
}

/** A valid access token, refreshed when it is about to expire. */
async function accessToken(app: FastifyInstance, orgId: string, scope: string): Promise<string> {
  const { db, config } = app.deps
  const row = await connection(db, orgId)
  if (!row.scopes.includes(scope)) throw new HttpError(409, 'missing_scope', "Ce service Google n'a pas été autorisé : reconnectez Google en le cochant.")
  const tokens = openSecret<Tokens>(config, orgId, `connection:${row.id}`, row.secrets!)
  if (tokens.expires_at - Date.now() > 60_000) return tokens.access_token
  if (!tokens.refresh_token) throw new ConnectorError('Autorisation Google expirée : reconnectez Google.', 409)
  const refreshed = await tokenRequest(app, { refresh_token: tokens.refresh_token, grant_type: 'refresh_token' }).catch(async error => {
    await db.run("UPDATE connections SET status = 'error', last_error = 'Autorisation expirée ou retirée', updated_at = now() WHERE id = ?", row.id)
    throw error
  })
  const next: Tokens = { access_token: String(refreshed.access_token), refresh_token: tokens.refresh_token, expires_at: Date.now() + Number(refreshed.expires_in ?? 3600) * 1000 }
  await db.run('UPDATE connections SET secrets = ?, updated_at = now() WHERE id = ?', sealSecret(config, orgId, `connection:${row.id}`, next), row.id)
  return next.access_token
}

async function googleApi(app: FastifyInstance, orgId: string, scope: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
  const token = await accessToken(app, orgId, scope)
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(30_000), redirect: 'error',
    })
  } catch {
    throw new ConnectorError('Google est injoignable. Réessayez dans quelques minutes.')
  }
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    const message = ((body.error as { message?: string } | undefined)?.message ?? '').slice(0, 200)
    throw new ConnectorError(`Google a refusé l'opération (${res.status})${message ? ` : ${message}` : ''}.`, res.status === 404 ? 404 : 502)
  }
  return body
}

export interface MailSummary { id: string; from: string; subject: string; date: string; snippet: string }

export async function gmailSearch(app: FastifyInstance, orgId: string, query: string, max = 10): Promise<MailSummary[]> {
  const base = googleConfig(app).gmailBase
  const list = await googleApi(app, orgId, GOOGLE_SERVICES.gmail_read.scopes[0], `${base}/gmail/v1/users/me/messages?${new URLSearchParams({ q: query.slice(0, 200), maxResults: String(Math.min(max, 20)) })}`)
  const ids = ((list.messages as Array<{ id: string }> | undefined) ?? []).slice(0, Math.min(max, 20))
  const out: MailSummary[] = []
  for (const { id } of ids) {
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) continue
    const m = await googleApi(app, orgId, GOOGLE_SERVICES.gmail_read.scopes[0],
      `${base}/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
    const headers = ((m.payload as { headers?: Array<{ name: string; value: string }> } | undefined)?.headers) ?? []
    const h = (name: string) => headers.find(x => x.name.toLowerCase() === name.toLowerCase())?.value?.slice(0, 300) ?? ''
    out.push({ id, from: h('From'), subject: h('Subject'), date: h('Date'), snippet: String(m.snippet ?? '').slice(0, 500) })
  }
  return out
}

/** RFC 2822 message; header injection refused. */
export function mimeMessage(to: string, subject: string, body: string): string {
  if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) throw new HttpError(400, 'bad_request', 'Destinataire ou objet invalide.')
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
  const content = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  return [`To: ${to}`, `Subject: ${encodedSubject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', content].join('\r\n')
}

export async function gmailSend(app: FastifyInstance, orgId: string, mail: { to: string; subject: string; body: string }): Promise<{ id: string }> {
  const base = googleConfig(app).gmailBase
  const raw = Buffer.from(mimeMessage(mail.to, mail.subject, mail.body), 'utf8').toString('base64url')
  const res = await googleApi(app, orgId, GOOGLE_SERVICES.gmail_send.scopes[0], `${base}/gmail/v1/users/me/messages/send`, { method: 'POST', body: { raw } })
  return { id: String(res.id ?? '') }
}

export async function sheetsAppend(app: FastifyInstance, orgId: string, input: { spreadsheetId: string; range: string; values: string[][] }): Promise<{ updatedRange: string | null; rows: number }> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(input.spreadsheetId)) throw new HttpError(400, 'bad_request', 'Identifiant de feuille Google invalide.')
  if (!/^[\p{L}\p{N} _'.-]{1,60}(?:![A-Z]{1,3}\d{0,7}(?::[A-Z]{1,3}\d{0,7})?)?$/u.test(input.range)) throw new HttpError(400, 'bad_request', 'Plage invalide (ex. Factures!A1).')
  const base = googleConfig(app).sheetsBase
  const url = `${base}/v4/spreadsheets/${input.spreadsheetId}/values/${encodeURIComponent(input.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
  // Text cells starting with = + - @ would be read as formulas: written as plain text instead.
  const values = input.values.slice(0, 500).map(r => r.slice(0, 50).map(c => (/^[=+\-@]/.test(String(c)) ? `'${c}` : String(c).slice(0, 5000))))
  const res = await googleApi(app, orgId, GOOGLE_SERVICES.sheets.scopes[0], url, { method: 'POST', body: { values } })
  const updates = res.updates as { updatedRange?: string; updatedRows?: number } | undefined
  return { updatedRange: updates?.updatedRange ?? null, rows: updates?.updatedRows ?? values.length }
}

export async function disconnectGoogle(app: FastifyInstance, orgId: string): Promise<void> {
  const { db, config } = app.deps
  const row = await db.get<ConnectionRow>("SELECT id, secrets, scopes, account FROM connections WHERE org_id = ? AND provider = 'google' AND status <> 'revoked'", orgId)
  if (!row) throw notFound('Connexion')
  if (row.secrets && app.deps.config.connectors.google) {
    const tokens = openSecret<Tokens>(config, orgId, `connection:${row.id}`, row.secrets)
    // Best effort: the grant is revoked at Google; the tokens are deleted here in any case.
    await fetch(`${app.deps.config.connectors.google.revokeUrl}?${new URLSearchParams({ token: tokens.refresh_token ?? tokens.access_token })}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    }).catch(() => undefined)
  }
  await db.run("UPDATE connections SET status = 'revoked', secrets = NULL, updated_at = now() WHERE id = ?", row.id)
}
