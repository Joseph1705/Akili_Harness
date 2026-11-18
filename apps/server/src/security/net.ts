/**
 * Outbound HTTP to addresses chosen by users (MCP servers): protection against SSRF (DIRECTIVES §7).
 * - https only (http only when private addresses are explicitly allowed, for self-hosted setups and tests);
 * - every resolved address is checked at connection time (no DNS-rebinding window): loopback, private,
 *   link-local (cloud metadata 169.254.169.254), carrier-grade NAT and unique-local ranges are refused;
 * - no redirects, a timeout, and a response size cap.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

export class BlockedDestination extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ipv4ToInt(ip)
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)))
  }
  const v6 = ip.toLowerCase()
  if (v6 === '::' || v6 === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
  if (mapped) return isPrivateAddress(mapped[1]!)
  return /^(?:fc|fd)/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6)
}

export interface SafeResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

export interface SafeRequest {
  method: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  allowPrivate?: boolean
}

export function safeRequest(target: string, opts: SafeRequest): Promise<SafeResponse> {
  let url: URL
  try { url = new URL(target) } catch { return Promise.reject(new BlockedDestination('Adresse invalide.')) }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && opts.allowPrivate)) return Promise.reject(new BlockedDestination('Seules les adresses https sont autorisées.'))
  if (url.username || url.password) return Promise.reject(new BlockedDestination('Identifiants dans l\'adresse refusés.'))
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !opts.allowPrivate && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    return Promise.reject(new BlockedDestination('Adresse interne refusée.'))
  }
  const guardedLookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 4)
      const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[]
      const bad = list.find(a => isPrivateAddress(a.address))
      if (bad && !opts.allowPrivate) return callback(new BlockedDestination(`Adresse interne refusée (${hostname}).`), '', 4)
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list)
      return callback(null, list[0]!.address, list[0]!.family)
    })
  }
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, { method: opts.method, headers: { 'user-agent': 'akili-harness', ...(opts.headers ?? {}) }, lookup: guardedLookup, timeout: opts.timeoutMs ?? 20_000 }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) { req.destroy(new BlockedDestination('Réponse trop volumineuse.')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('Délai dépassé.')))
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}
