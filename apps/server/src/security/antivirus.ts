/**
 * Malware scanning of uploads with ClamAV, over its documented TCP protocol (zINSTREAM): optional,
 * enabled by CLAMAV_HOST (DIRECTIVES §7 "malware scanning where appropriate"). When it is configured
 * and cannot answer, uploads are refused (fail closed) rather than accepted unscanned.
 */
import { connect } from 'node:net'

export type ScanResult = { clean: true } | { clean: false; signature: string }

export class ScannerUnavailable extends Error {}

const CHUNK = 64 * 1024

export function scanWithClamd(bytes: Buffer, host: string, port: number, timeoutMs = 30_000): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    let answer = ''
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    const socket = connect({ host, port })
    socket.setTimeout(timeoutMs, () => socket.destroy(new ScannerUnavailable('antivirus: délai dépassé')))
    socket.on('connect', () => {
      socket.write('zINSTREAM\0')
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const part = bytes.subarray(i, i + CHUNK)
        const size = Buffer.alloc(4)
        size.writeUInt32BE(part.length)
        socket.write(size)
        socket.write(part)
      }
      socket.write(Buffer.alloc(4)) // a zero-length chunk ends the stream
    })
    socket.on('data', data => { answer += data.toString('utf8') })
    socket.on('error', error => done(() => reject(error instanceof ScannerUnavailable ? error : new ScannerUnavailable(`antivirus injoignable (${error.message})`))))
    socket.on('close', () => done(() => {
      const reply = answer.replace(/\0/g, '').trim()
      if (/^stream: OK$/.test(reply)) resolve({ clean: true })
      else if (/FOUND$/.test(reply)) resolve({ clean: false, signature: reply.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '').slice(0, 120) })
      else reject(new ScannerUnavailable(`antivirus : réponse inattendue (${reply.slice(0, 80) || 'vide'})`))
    }))
  })
}
