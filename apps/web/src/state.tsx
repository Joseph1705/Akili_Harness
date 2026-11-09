/** Who is logged in, in which organization, and the server's public settings. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'

export type Role = 'owner' | 'admin' | 'operator' | 'reader' | 'accountant'

export interface Me {
  user: { id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; locale: string }
  org: null | {
    id: string; kind: 'company' | 'individual'; name: string; plan: 'solo' | 'entreprise'; data_mode: string; role: Role
    sector: string | null; city: string | null; province: string | null; currency: string; secondary_currencies: string | null; team_size: string | null
    rccm: string | null; id_nat: string | null; nif: string | null; address: string | null; vat_status: 'yes' | 'no' | 'unknown'
    accounting_software: string | null; reports_channel: string | null; bank_details: string | null; has_logo: boolean
    onboarding_step: number; onboarding_done_at: string | null
  }
  orgs: Array<{ id: string; name: string; plan: string; role: Role }>
  app: { brand: string; demoMode: boolean; hostingLabel: string; models: { deepseek: boolean; anthropic: boolean } }
}

export interface PublicConfig { brand: string; hostingLabel: string; demoMode: boolean; version: string }

interface Session {
  me: Me | null
  config: PublicConfig | null
  loading: boolean
  refresh: () => Promise<void>
  toast: (text: string, kind?: 'ok' | 'err') => void
  logoVersion: number
  bumpLogo: () => void
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const [logoVersion, setLogoVersion] = useState(0)

  const refresh = useCallback(async () => {
    try { setMe(await api.get<Me>('/api/auth/me')) } catch { setMe(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => {
    api.get<PublicConfig>('/api/public/config').then(c => { setConfig(c); document.title = `${c.brand} — Agents IA souverains` }).catch(() => undefined)
    void refresh()
  }, [refresh])

  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setMessage({ text, kind })
    window.setTimeout(() => setMessage(m => (m?.text === text ? null : m)), 4500)
  }, [])

  return (
    <Ctx.Provider value={{ me, config, loading, refresh, toast, logoVersion, bumpLogo: () => setLogoVersion(v => v + 1) }}>
      {children}
      {message && <div className={`toast ${message.kind === 'err' ? 'err' : ''}`} role="status">{message.text}</div>}
    </Ctx.Provider>
  )
}

export function useSession(): Session {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('SessionProvider missing')
  return ctx
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Propriétaire', admin: 'Administrateur', operator: 'Opérateur', reader: 'Lecteur', accountant: 'Comptable externe',
}
export const can = {
  operate: (r?: Role) => r === 'owner' || r === 'admin' || r === 'operator',
  validate: (r?: Role) => r === 'owner' || r === 'admin' || r === 'operator' || r === 'accountant',
  configure: (r?: Role) => r === 'owner' || r === 'admin',
}

export function displayName(me: Me | null): string {
  if (!me) return ''
  return [me.user.first_name, me.user.last_name].filter(Boolean).join(' ') || me.user.email
}
export function initials(me: Me | null): string {
  if (!me) return ''
  const parts = [me.user.first_name, me.user.last_name].filter(Boolean) as string[]
  return (parts.length ? parts.map(p => p[0]).join('') : me.user.email.slice(0, 2)).toUpperCase().slice(0, 2)
}
