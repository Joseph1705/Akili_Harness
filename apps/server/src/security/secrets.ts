/** Secrets stored in the database (OAuth tokens, API tokens): AES-256-GCM with the organization's key. */
import type { Config } from '../config.js'
import { decrypt, encrypt, orgKey } from './crypto.js'

export function sealSecret(config: Config, orgId: string, purpose: string, value: unknown): Buffer {
  return encrypt(orgKey(config.masterKey, orgId), Buffer.from(JSON.stringify(value)), `${orgId}/secret/${purpose}`)
}

export function openSecret<T>(config: Config, orgId: string, purpose: string, sealed: Buffer): T {
  return JSON.parse(decrypt(orgKey(config.masterKey, orgId), sealed, `${orgId}/secret/${purpose}`).toString('utf8')) as T
}
