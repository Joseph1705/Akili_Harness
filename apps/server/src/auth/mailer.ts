/**
 * Transactional e-mail over SMTP (directive 5.1). Today: a Gmail account with an app password;
 * later a transactional provider (same variables). Without SMTP (development only), the code is
 * written to the server console — never to the browser.
 */
import nodemailer from 'nodemailer'
import type { Config } from '../config.js'

export interface Mailer {
  sendLoginCode(email: string, code: string): Promise<void>
}

export function loginCodeMessage(brand: string, code: string): { subject: string; text: string; html: string } {
  const subject = `${brand} — votre code de connexion : ${code}`
  const text = [
    'Bonjour,',
    '',
    `Votre code de connexion à ${brand} est : ${code}`,
    '',
    'Il est valable 10 minutes et ne peut servir qu\'une fois.',
    'Si vous n\'avez pas demandé ce code, ignorez ce message : personne ne peut se connecter sans lui.',
  ].join('\n')
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#F6F2E9;font-family:Arial,Helvetica,sans-serif;color:#16211B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="background:#FFFDF9;border:1px solid #D9D3C5;padding:28px">
<tr><td style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#4D5A52">${escapeHtml(brand)}</td></tr>
<tr><td style="padding-top:14px;font-size:16px">Votre code de connexion :</td></tr>
<tr><td style="padding:16px 0;font-family:'Courier New',monospace;font-size:32px;letter-spacing:.3em;color:#00603A;font-weight:bold">${code}</td></tr>
<tr><td style="font-size:14px;color:#4D5A52">Valable 10 minutes, utilisable une seule fois.<br>Si vous n'avez pas demandé ce code, ignorez ce message.</td></tr>
</table></td></tr></table></body></html>`
  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** `transportOverrides` exists for tests (local SMTP server with a self-signed certificate); production passes nothing. */
export function createMailer(config: Config, transportOverrides: { tls?: { rejectUnauthorized: boolean } } = {}): Mailer {
  if (!config.smtp) {
    return {
      async sendLoginCode(email, code) {
        if (config.env === 'production') throw new Error('mailer: SMTP not configured')
        console.log(`[mail:dev] code de connexion pour ${email} : ${code}`)
      },
    }
  }
  const smtp = config.smtp
  const transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
    requireTLS: !smtp.secure,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    ...transportOverrides,
  })
  return {
    async sendLoginCode(email, code) {
      const message = loginCodeMessage(config.brand, code)
      await transport.sendMail({ from: smtp.from, to: email, ...message })
    },
  }
}
