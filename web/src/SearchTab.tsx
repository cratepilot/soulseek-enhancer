import type {JSX} from 'react'
import {useCallback, useEffect, useRef, useState} from 'react'
import {enqueueDownload, pollSearch, startSearch, type ManualCandidate} from './api.js'
import type {UseIgnoredPeers} from './use-ignored-peers.js'

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

function fmtLength(seconds: number | null): string {
  if (seconds === null) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Manual search: query → poll until complete → pick a candidate → download. */
export function SearchTab({ignored}: {ignored: UseIgnoredPeers}): JSX.Element {
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<ManualCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current) }, [])

  const run = useCallback(async () => {
    const q = query.trim()
    if (q === '' || searching) return
    setSearching(true)
    setError(null)
    setCandidates([])
    setQueued(new Set())
    try {
      const {searchId} = await startSearch(q)
      const poll = async (): Promise<void> => {
        const res = await pollSearch(searchId)
        setCandidates(res.candidates)
        if (!res.complete) {
          pollTimer.current = setTimeout(() => { void poll().catch(onPollError) }, 1500)
        } else {
          setSearching(false)
        }
      }
      const onPollError = (e: unknown): void => {
        setError(e instanceof Error ? e.message : 'search failed')
        setSearching(false)
      }
      await poll().catch(onPollError)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'search failed')
      setSearching(false)
    }
  }, [query, searching])

  const download = useCallback(async (c: ManualCandidate) => {
    try {
      await enqueueDownload({username: c.username, filename: c.filename, sizeBytes: c.sizeBytes})
      setQueued((prev) => new Set(prev).add(`${c.username}:${c.filename}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'download failed')
    }
  }, [])

  const visible = candidates.filter((c) => !ignored.peerSet.has(c.username))
  const hiddenCount = candidates.length - visible.length

  return (
    <section>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void run() }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="artist title (remix)…"
          autoFocus
        />
        <button type="submit" disabled={searching || query.trim() === ''}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {hiddenCount > 0 && <p className="muted">{hiddenCount} result(s) hidden from blacklisted peers</p>}
      {visible.length > 0 && (
        <table>
          <thead>
            <tr><th>File</th><th>Fmt</th><th>Bitrate</th><th>Length</th><th>Size</th><th>Peer</th><th>Queue</th><th></th></tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const key = `${c.username}:${c.filename}`
              return (
                <tr key={key}>
                  <td className="filename" title={c.filename}>{c.filename.split(/[\\/]/).pop()}</td>
                  <td>{c.format}</td>
                  <td>{c.bitrateKbps ?? '—'}</td>
                  <td>{fmtLength(c.lengthSeconds)}</td>
                  <td>{fmtSize(c.sizeBytes)}</td>
                  <td>{c.username}</td>
                  <td>{c.hasFreeUploadSlot ? 'free' : c.queueLength}</td>
                  <td className="row">
                    <button disabled={queued.has(key)} onClick={() => void download(c)}>
                      {queued.has(key) ? 'Queued ✓' : 'Download'}
                    </button>
                    <button className="ghost" title="Blacklist this peer" onClick={() => void ignored.add(c.username)}>
                      Block
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {!searching && candidates.length === 0 && <p className="muted">No results yet — run a search.</p>}
    </section>
  )
}
