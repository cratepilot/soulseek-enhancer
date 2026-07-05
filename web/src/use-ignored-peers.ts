import {useCallback, useEffect, useMemo, useState} from 'react'
import {addIgnoredPeer, listIgnoredPeers, removeIgnoredPeer, type IgnoredPeer} from './api.js'

export interface UseIgnoredPeers {
  /** The blacklist, newest first. */
  peers: IgnoredPeer[]
  /** Usernames as a Set for O(1) membership checks (candidate hiding, pill state). */
  peerSet: Set<string>
  loading: boolean
  /** Add a username to the global blacklist (idempotent). Optimistically updates the list. */
  add: (username: string) => Promise<void>
  /** Remove a username from the global blacklist. */
  remove: (username: string) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * The global peer blacklist. Bound to the server's IgnoredPeerStore — the SAME
 * store the auto-download pipeline enforces through the toolkit's
 * `IgnoredPeerStore` port, so hiding a peer here also stops the orchestrator
 * from ever auto-downloading from them. This hook only drives the UI.
 */
export function useIgnoredPeers(): UseIgnoredPeers {
  const [peers, setPeers] = useState<IgnoredPeer[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setPeers(await listIgnoredPeers())
    } catch {
      // Non-fatal — keep whatever we last had; the UI degrades to "no blacklist".
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const add = useCallback(async (username: string) => {
    const item = await addIgnoredPeer(username)
    setPeers((prev) => (prev.some((p) => p.username === item.username) ? prev : [item, ...prev]))
  }, [])

  const remove = useCallback(async (username: string) => {
    await removeIgnoredPeer(username)
    setPeers((prev) => prev.filter((p) => p.username !== username))
  }, [])

  const peerSet = useMemo(() => new Set(peers.map((p) => p.username)), [peers])

  return {peers, peerSet, loading, add, remove, refresh}
}
