import type {JSX} from 'react'
import {useCallback, useEffect, useState} from 'react'
import {
  importWantlistCsv,
  listWantlist,
  previewWantlistCsv,
  removeWantlistTrack,
  startAutoDownload,
  type CsvMapping,
  type CsvPreview,
  type CsvRole,
  type WantlistTrack,
} from './api.js'

const ROLES: Array<{role: CsvRole, label: string, required: boolean}> = [
  {role: 'artist', label: 'Artist', required: true},
  {role: 'title', label: 'Title', required: true},
  {role: 'remix', label: 'Remix', required: false},
  {role: 'length', label: 'Length', required: false},
  {role: 'copyText', label: 'Search text override', required: false},
]

function statusLabel(t: WantlistTrack): string {
  if (t.lastJob) return t.lastJob.status
  if (t.lastSearch) {
    if (t.lastSearch.skipReason) return `skipped: ${t.lastSearch.skipReason}`
    return `${t.lastSearch.candidateCount} candidate(s)`
  }
  return '—'
}

/**
 * The CSV-driven wantlist. Import rows, then trigger the full auto-download
 * pipeline per track (search → rank → download, peer blacklist enforced).
 * Scheduling is deliberately manual-only — every download is user-triggered.
 */
export function WantlistTab(): JSX.Element {
  const [tracks, setTracks] = useState<WantlistTrack[]>([])
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [importReport, setImportReport] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    try {
      setTracks(await listWantlist())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load wantlist')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000) // pick up background pipeline progress
    return () => clearInterval(t)
  }, [refresh])

  // Step 1: inspect the CSV — headers, sample rows, suggested column mapping.
  const doPreview = useCallback(async (text: string) => {
    if (text.trim() === '') return
    setError(null)
    setImportReport(null)
    try {
      const p = await previewWantlistCsv(text)
      setPreview(p)
      setMapping(p.autoMapping)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'preview failed')
    }
  }, [])

  // Step 2: import with the confirmed mapping (server remembers it).
  const doImport = useCallback(async () => {
    if (csv.trim() === '' || mapping === null) return
    setError(null)
    try {
      const res = await importWantlistCsv(csv, mapping)
      setImportReport(`imported ${res.imported} track(s)${res.errors.length > 0 ? `, ${res.errors.length} error(s): ${res.errors.slice(0, 3).join('; ')}` : ''}`)
      setCsv('')
      setPreview(null)
      setMapping(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import failed')
    }
  }, [csv, mapping, refresh])

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    setCsv(text)
    await doPreview(text)
  }, [doPreview])

  const setRole = useCallback((role: CsvRole, headerKey: string) => {
    setMapping((prev) => prev === null ? prev : {...prev, [role]: headerKey === '' ? null : headerKey})
  }, [])

  const mappingValid = mapping !== null && mapping.artist !== null && mapping.title !== null

  const autoDownload = useCallback(async (id: string) => {
    setError(null)
    try {
      await startAutoDownload(id)
      setStarted((prev) => new Set(prev).add(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to start download')
    }
  }, [])

  return (
    <section>
      <details open={tracks.length === 0 || preview !== null}>
        <summary>Import CSV</summary>
        <p className="muted">
          Any CSV with a header row works — after loading it you choose which column is which.
          Cleaning rules from Settings are applied on import.
        </p>
        <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={6}
          placeholder={'artist,title,remix,length\nHot Since 82,Alive,,6:12'}
        />
        {preview === null && (
          <button onClick={() => void doPreview(csv)} disabled={csv.trim() === ''}>Preview &amp; map columns</button>
        )}
        {preview !== null && mapping !== null && (
          <div className="mapping">
            <h2>Column mapping</h2>
            {ROLES.map(({role, label, required}) => (
              <label className="row" key={role}>
                <span className="role-label">{label}{required ? ' *' : ''}</span>
                <select value={mapping[role] ?? ''} onChange={(e) => setRole(role, e.target.value)}>
                  <option value="">— not in this file —</option>
                  {preview.headers.map((h) => (
                    <option key={h.key} value={h.key}>{h.raw}</option>
                  ))}
                </select>
              </label>
            ))}
            {preview.sampleRows.length > 0 && (
              <table>
                <thead>
                  <tr>{preview.headers.map((h) => <th key={h.key}>{h.raw}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.sampleRows.map((r, i) => (
                    <tr key={i}>{preview.headers.map((h, j) => <td key={h.key}>{r[j] ?? ''}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="row">
              <button onClick={() => void doImport()} disabled={!mappingValid}>Import</button>
              <button className="ghost" onClick={() => { setPreview(null); setMapping(null) }}>Cancel</button>
              {!mappingValid && <span className="muted">Artist and Title must be mapped.</span>}
            </div>
          </div>
        )}
        {importReport && <p className="muted">{importReport}</p>}
      </details>
      {error && <p className="error">{error}</p>}
      {tracks.length > 0 && (
        <table>
          <thead>
            <tr><th>Artist</th><th>Title</th><th>Remix</th><th>Length</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {tracks.map((t) => (
              <tr key={t.id}>
                <td>{t.artist}</td>
                <td>{t.title}</td>
                <td>{t.remix ?? '—'}</td>
                <td>{t.lengthMs !== null ? `${Math.floor(t.lengthMs / 60000)}:${String(Math.round((t.lengthMs % 60000) / 1000)).padStart(2, '0')}` : '—'}</td>
                <td>{started.has(t.id) && !t.lastJob && !t.lastSearch ? 'searching…' : statusLabel(t)}</td>
                <td className="row">
                  <button onClick={() => void autoDownload(t.id)}>Auto-download</button>
                  <button className="ghost" onClick={() => void removeWantlistTrack(t.id).then(refresh)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tracks.length === 0 && <p className="muted">Wantlist is empty — import a CSV above.</p>}
    </section>
  )
}
