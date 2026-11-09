/** Invoices by status. */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, api, money } from '../api'
import { Shell } from '../components/Shell'

interface Row { id: string; number: string; status: string; total_cents: number; currency: string; created_at: string; decided_at: string | null; client_name: string; agent_name: string; filename: string; attention: number }
const TABS = [['draft', 'À valider'], ['validated', 'Validées'], ['rejected', 'Rejetées']] as const

export function Validations() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('draft')
  const [rows, setRows] = useState<Row[] | null>(null)
  useEffect(() => { setRows(null); api.get<{ invoices: Row[] }>(`/api/invoices?status=${tab}`).then(r => setRows(r.invoices)).catch(() => setRows([])) }, [tab])
  return (
    <Shell crumb="Validations" title="Factures préparées par vos agents">
      <div className="page">
        <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
        <div className="card">
          {rows === null ? <div className="empty"><span className="spinner" /></div> : rows.length === 0 ? <div className="empty">Aucune facture ici.</div> : (
            <table className="table">
              <thead><tr><th>Numéro</th><th>Client</th><th>Rapport</th><th>Préparée</th><th className="right">Total TTC</th><th /></tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.id}>
                  <td className="mono small">{r.number} {r.attention > 0 && r.status === 'draft' && <span className="badge alert">{r.attention} à vérifier</span>}</td>
                  <td><b>{r.client_name}</b></td>
                  <td className="small muted">{r.filename}</td>
                  <td className="small muted">{ago(r.decided_at ?? r.created_at)}</td>
                  <td className="right mono">{money(r.total_cents, r.currency)}</td>
                  <td className="right"><Link className="btn small" to={`/validations/${r.id}`}>{r.status === 'draft' ? 'Examiner' : 'Ouvrir'}</Link></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
    </Shell>
  )
}
