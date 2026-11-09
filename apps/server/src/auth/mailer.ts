/**
 * Transactional e-mail. Demo and development: the message goes to the server console
 * (and, in demo mode only, the last code is exposed to the login screen).
 * Production: plug a transactional SMTP provider (directive 5.1) — not configured yet.
 */
import type { Config } from '../config.js'

export interface Mailer {
  sendLoginCode(email: string, code: string): Promise<void>
  /** Demo mode only: last code sent to this address, for the on-screen helper. */
  lastCodeFor?(email: string): string | undefined
}

export function createMailer(config: Config): Mailer {
  const last = new Map<string, string>()
  return {
    async sendLoginCode(email, code) {
      if (config.env === 'production') throw new Error('mailer: no SMTP provider configured')
      if (config.demoMode) last.set(email, code)
      if (config.env !== 'test') console.log(`[mail] code de connexion pour ${email} : ${code}`)
    },
    lastCodeFor: config.demoMode ? (email) => last.get(email) : undefined,
  }
}
