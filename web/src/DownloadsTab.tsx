import type {JSX} from 'react'
import {useCallback, useEffect, useState} from 'react'
import {
  cancelDownload,
  listDownloadedFiles,
  listTransfers,
  type DownloadedFile,
  type TransferRow,
} from './api.js'

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

/** Live transfers (from slskd) + the durable on-disk downloaded files list. */
export function DownloadsTab(): JSX.Element {
  const [transfers, setTransfers] = useState<TransferRow[]>([])
  const [files, setFiles] = useState<DownloadedFile[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([listTransfers(), listDownloadedFiles()])
      setTransfers(t.transfers)
      setFiles(f.files)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load downloads')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [refresh])

  const cancel = useCallback(async (row: TransferRow, remove: boolean) => {
    try {
      await cancelDownload(row.username, row.id, remove)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'cancel failed')
    }
  }, [refresh])

  return (
    <section>
      {error && <p className="error">{error}</p>}
      <h2>Transfers</h2>
      {transfers.length === 0 && <p className="muted">No active transfers.</p>}
      {transfers.length > 0 && (
        <table>
          <thead>
            <tr><th>File</th><th>Peer</th><th>State</th><th>Progress</th><th></th></tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={`${t.username}:${t.id}`}>
                <td className="filename" title={t.filename}>{t.filename.split(/[\\/]/).pop()}</td>
                <td>{t.username}</td>
                <td>{t.state}</td>
                <td>
                  <progress max={100} value={t.percent} /> {t.percent}%
                </td>
                <td className="row">
                  <button className="ghost" onClick={() => void cancel(t, false)}>Cancel</button>
                  <button className="ghost" onClick={() => void cancel(t, true)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Downloaded files</h2>
      {files.length === 0 && <p className="muted">Nothing on disk yet.</p>}
      {files.length > 0 && (
        <table>
          <thead>
            <tr><th>File</th><th>Fmt</th><th>Size</th><th>Downloaded</th></tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.relPath}>
                <td className="filename" title={f.relPath}>{f.name}</td>
                <td>{f.format}</td>
                <td>{fmtSize(f.sizeBytes)}</td>
                <td>{new Date(f.createdMs).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
