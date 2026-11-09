/** API client: same-origin cookies, JSON, readable French errors. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: Record<string, unknown>) { super(message) }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { ...headers } }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new ApiError(0, 'network', 'Connexion au serveur impossible. Vérifiez le réseau, puis réessayez.')
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    const fields = Array.isArray(data.fields) ? (data.fields as Array<{ message: string }>).map(f => f.message).join(' ') : ''
    throw new ApiError(res.status, String(data.error ?? 'error'), [String(data.message ?? 'Erreur.'), fields].filter(Boolean).join(' '), data)
  }
  return data as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}, headers?: Record<string, string>) => request<T>('POST', url, body, headers),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
}

export async function download(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new ApiError(res.status, 'download', 'Téléchargement impossible.')
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export const money = (cents: number, currency = 'USD') =>
  `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ | /g, ' ')} ${currency}`

export function ago(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return "à l'instant"
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
export const date = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('fr-FR')
export const uuid = () => crypto.randomUUID()
