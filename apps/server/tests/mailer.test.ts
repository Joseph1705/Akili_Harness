import { SMTPServer } from 'smtp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { createMailer, loginCodeMessage } from '../src/auth/mailer.js'
import { loadConfig } from '../src/config.js'

let server: SMTPServer | undefined
afterEach(async () => { await new Promise<void>(r => (server ? server.close(() => r()) : r())); server = undefined })

describe('login code e-mail over SMTP', () => {
  it('authenticates, sends over TLS and delivers the code', async () => {
    const received: Array<{ from: string; to: string[]; body: string; user: string }> = []
    server = new SMTPServer({
      secure: true, // TLS from the first byte, as Gmail on port 465 (self-signed certificate in this test)
      authMethods: ['PLAIN', 'LOGIN'],
      onAuth(auth, _session, cb) { auth.username === 'josephprods@gmail.com' && auth.password === 'app-password' ? cb(null, { user: auth.username }) : cb(new Error('bad auth')) },
      onData(stream, session, cb) {
        let body = ''
        stream.on('data', c => { body += c })
        stream.on('end', () => {
          received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map(r => r.address), body, user: String(session.user) })
          cb()
        })
      },
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.server.address() as { port: number }).port
    const config = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://x@localhost/x', AKILI_DATA_DIR: '/tmp/akili-mail-test', AKILI_BRAND_NAME: 'Akili',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'true', SMTP_USER: 'josephprods@gmail.com', SMTP_PASSWORD: 'app-password',
      MAIL_FROM: 'Akili <josephprods@gmail.com>',
    })
    await createMailer(config, { tls: { rejectUnauthorized: false } }).sendLoginCode('mireille@example.cd', '482913')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ from: 'josephprods@gmail.com', to: ['mireille@example.cd'], user: 'josephprods@gmail.com' })
    expect(received[0]!.body).toContain('482913')
    expect(received[0]!.body).toMatch(/^Subject: =\?UTF-8\?/m) // accented subject, encoded for transport
  })

  it('writes a clear French message with the code and its validity', () => {
    const m = loginCodeMessage('Akili', '000123')
    expect(m.subject).toBe('Akili — votre code de connexion : 000123')
    expect(m.text).toContain('valable 10 minutes')
    expect(m.html).toContain('000123')
  })
})
