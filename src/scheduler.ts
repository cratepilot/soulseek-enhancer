// Opt-in re-search scheduler (default OFF — downloads are manual-only unless
// the user enables this in Settings).
//
// Every tick, unresolved wantlist tracks whose last search is older than the
// configured interval are re-run through the auto pipeline, a few at a time.

import type {DbShape, WantlistRecord} from './store/json-db.js'

const TERMINAL_OK = 'completed'
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped', 'deleted'])

export interface SelectDueOpts {
  now: Date
  intervalMs: number
  /** Max tracks returned per tick, so one tick can't flood slskd. */
  maxBatch: number
}

/**
 * Which wantlist tracks are due for a (re-)search:
 *  - never downloaded (no completed job), AND
 *  - not currently in flight (no non-terminal job — the reconcile sweep owns those), AND
 *  - never searched, or last searched more than `intervalMs` ago.
 * Never-searched tracks first, then stalest search first.
 */
export function selectDueTracks(db: DbShape, opts: SelectDueOpts): WantlistRecord[] {
  const completedTracks = new Set<string>()
  const inFlightTracks = new Set<string>()
  for (const j of db.jobs) {
    if (j.status === TERMINAL_OK) completedTracks.add(j.trackId)
    else if (!TERMINAL_STATUSES.has(j.status)) inFlightTracks.add(j.trackId)
  }
  const lastSearchAt = new Map<string, string>()
  for (const s of db.searches) {
    const prev = lastSearchAt.get(s.trackId)
    if (prev === undefined || s.ranAt > prev) lastSearchAt.set(s.trackId, s.ranAt)
  }

  const cutoff = new Date(opts.now.getTime() - opts.intervalMs).toISOString()
  const due = db.wantlist.filter((w) => {
    if (completedTracks.has(w.id) || inFlightTracks.has(w.id)) return false
    const last = lastSearchAt.get(w.id)
    return last === undefined || last < cutoff
  })

  due.sort((a, b) => {
    const la = lastSearchAt.get(a.id)
    const lb = lastSearchAt.get(b.id)
    if (la === undefined && lb === undefined) return a.addedAt.localeCompare(b.addedAt)
    if (la === undefined) return -1
    if (lb === undefined) return 1
    return la.localeCompare(lb)
  })
  return due.slice(0, opts.maxBatch)
}
