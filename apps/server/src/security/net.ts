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
import { BlockList, isIP, type LookupFunction } from 'node:net'

export class BlockedDestination extends Error {}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
// IPv6 ranges that are internal, or that carry an IPv4 address a gateway could route inward
// (IPv4-compatible, NAT64, 6to4, Teredo). IPv4-mapped forms (::ffff:a.b.c.d, ::ffff:7f00:1…) are
// checked against the IPv4 ranges by BlockList itself, whatever their spelling.
const V6_BLOCKED: Array<[string, number]> = [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]
const BLOCKED = new BlockList()
for (const [base, bits] of V4_BLOCKED) BLOCKED.addSubnet(base, bits, 'ipv4')
for (const [base, bits] of V6_BLOCKED) BLOCKED.addSubnet(base, bits, 'ipv6')

/** True for an address we must never connect to on a user's behalf (anything that is not an IP is refused too). */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  return BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6')
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
