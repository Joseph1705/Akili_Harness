/** Choose report files: from the computer, or (demo mode) from the fictitious reports shipped with the app. */
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Icon } from '../icons'
import { useSession } from '../state'

export function ReportPicker({ files, onChange, max = 20 }: { files: File[]; onChange: (files: File[]) => void; max?: number }) {
  const { me, toast } = useSession()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [demo, setDemo] = useState<string[]>([])

  useEffect(() => {
    if (me?.app.demoMode) api.get<{ reports: string[] }>('/api/demo/reports').then(r => setDemo(r.reports)).catch(() => undefined)
  }, [me])

  const add = (list: File[]) => {
    const merged = [...files, ...list.filter(f => !files.some(x => x.name === f.name))]
    if (merged.length > max) toast(`${max} fichiers au maximum.`, 'err')
    onChange(merged.slice(0, max))
  }
  async function addDemo(name: string) {
    const res = await fetch(`/api/demo/reports/${encodeURIComponent(name)}`, { credentials: 'same-origin' })
    if (!res.ok) return toast('Rapport introuvable.', 'err')
    add([new File([await res.blob()], name)])
  }

  return (
    <div className="stack" style={{ gap: 8, width: '100%' }}>
      <div className={`dropzone${over ? ' over' : ''}`}
        onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); add([...e.dataTransfer.files]) }}>
        <input ref={input} type="file" multiple accept=".pdf,.xlsx,.csv,application/pdf,text/csv" className="sr-only" onChange={e => { add([...(e.target.files ?? [])]); e.target.value = '' }} />
        Glissez vos rapports ici (PDF, Excel, CSV) ou{' '}
        <button type="button" className="btn small" onClick={() => input.current?.click()}><Icon name="upload" size={14} /> Joindre des rapports</button>
      </div>
      {demo.length > 0 && (
        <div className="small" style={{ textAlign: 'left' }}>
          <span className="muted">Rapports fictifs de démonstration : </span>
          <span className="chips" style={{ justifyContent: 'flex-start', marginTop: 6 }}>
            {demo.map(n => <button type="button" key={n} className={`chip${files.some(f => f.name === n) ? ' on' : ''}`} onClick={() => addDemo(n)}>{n.replace(/^RA-2026-10-/, '').replace(/\.(pdf|xlsx|csv)$/, m => ` ${m.slice(1).toUpperCase()}`)}</button>)}
          </span>
        </div>
      )}
      {files.length > 0 && (
        <div className="chips" style={{ justifyContent: 'flex-start' }}>
          {files.map(f => <span key={f.name} className="chip on">{f.name}<button type="button" aria-label={`Retirer ${f.name}`} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }} onClick={() => onChange(files.filter(x => x !== f))}><Icon name="x" size={12} /></button></span>)}
        </div>
      )}
    </div>
  )
}
