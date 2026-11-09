/** Choose report files from the computer: button or drag and drop. */
import { useRef, useState } from 'react'
import { Icon } from '../icons'
import { useSession } from '../state'

export function ReportPicker({ files, onChange, max = 20 }: { files: File[]; onChange: (files: File[]) => void; max?: number }) {
  const { toast } = useSession()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const add = (list: File[]) => {
    const merged = [...files, ...list.filter(f => !files.some(x => x.name === f.name))]
    if (merged.length > max) toast(`${max} fichiers au maximum.`, 'err')
    onChange(merged.slice(0, max))
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
      {files.length > 0 && (
        <div className="chips" style={{ justifyContent: 'flex-start' }}>
          {files.map(f => <span key={f.name} className="chip on">{f.name}<button type="button" aria-label={`Retirer ${f.name}`} style={{ border: 0, background: 'none', cursor: 'pointer', color: 'inherit' }} onClick={() => onChange(files.filter(x => x !== f))}><Icon name="x" size={12} /></button></span>)}
        </div>
      )}
    </div>
  )
}
