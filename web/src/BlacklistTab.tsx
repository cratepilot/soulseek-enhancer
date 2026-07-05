import type {JSX} from 'react'
import {useState} from 'react'
import type {UseIgnoredPeers} from './use-ignored-peers.js'

/**
 * Manage the global peer blacklist. Peers here are hidden from search results
 * AND excluded from the auto-download pipeline (enforced server-side through
 * the toolkit's IgnoredPeerStore port).
 */
export function BlacklistTab({ignored}: {ignored: UseIgnoredPeers}): JSX.Element {
  const [username, setUsername] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    const name = username.trim()
    if (name === '') return
    try {
      await ignored.add(name)
      setUsername('')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to add peer')
    }
  }

  return (
    <section>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void add() }}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="peer username…"
        />
        <button type="submit" disabled={username.trim() === ''}>Block peer</button>
      </form>
      {error && <p className="error">{error}</p>}
      {ignored.loading && <p className="muted">Loading…</p>}
      {!ignored.loading && ignored.peers.length === 0 && <p className="muted">No blacklisted peers.</p>}
      {ignored.peers.length > 0 && (
        <table>
          <thead>
            <tr><th>Peer</th><th>Blocked</th><th></th></tr>
          </thead>
          <tbody>
            {ignored.peers.map((p) => (
              <tr key={p.username}>
                <td>{p.username}</td>
                <td>{new Date(p.addedAt).toLocaleString()}</td>
                <td><button className="ghost" onClick={() => void ignored.remove(p.username)}>Unblock</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
