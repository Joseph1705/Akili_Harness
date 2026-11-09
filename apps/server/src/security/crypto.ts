/** Encryption at rest: AES-256-GCM with one key per organization, derived from the master key (HKDF-SHA256). */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

export function orgKey(master: Buffer, orgId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from('akili-org-files-v1'), Buffer.from(orgId), 32))
}

const VERSION = 1

/** Layout: version(1) | iv(12) | tag(16) | ciphertext. The org id is bound as associated data. */
export function encrypt(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
}

export function decrypt(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed[0] !== VERSION) throw new Error('crypto: unknown format')
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(sealed.subarray(13, 29))
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()])
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Keyed hash for secrets stored in the database (login codes, session tokens). */
export function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex')
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}
