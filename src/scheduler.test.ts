import {describe, expect, it} from 'vitest'
import type {DbShape} from './store/json-db.js'
import {selectDueTracks} from './scheduler.js'

const NOW = new Date('2026-07-05T12:00:00Z')
const HOUR = 60 * 60 * 1000

function db(overrides: Partial<DbShape>): DbShape {
  return {seq: 0, jobs: [], searches: [], ignoredPeers: [], wantlist: [], ...overrides}
}

function want(id: string, addedAt = '2026-07-01T00:00:00Z') {
  return {id, artist: 'A', title: 'T', remix: null, lengthMs: null, copyText: null, addedAt}
}

function search(trackId: string, ranAt: string) {
  return {
    id: `s-${trackId}`, userId: 'local', trackId, queryText: 'q', slskdSearchId: null,
    skipReason: 'no_responses', triggeredBy: 'auto' as const, ranAt, candidates: [],
  }
}

function job(trackId: string, status: string) {
  return {
    id: `j-${trackId}`, userId: 'local', trackId, trackSearchId: 's', candidateId: 'c',
    slskdSearchId: 'x', chosenUsername: 'p', chosenFilename: 'f', chosenFormat: 'flac',
    chosenBitrate: null, status, slskdTransferId: null, localFilePath: null,
    completedAt: null, updatedAt: '2026-07-05T00:00:00Z',
  }
}

describe('selectDueTracks', () => {
  it('includes never-searched tracks first, then stalest, capped at maxBatch', () => {
    const d = db({
      wantlist: [want('w1'), want('w2'), want('w3')],
      searches: [
        search('w2', '2026-07-05T00:00:00Z'), // 12h ago — stale at 6h interval
        search('w3', '2026-07-04T00:00:00Z'), // 36h ago — stalest
      ],
    })
    const due = selectDueTracks(d, {now: NOW, intervalMs: 6 * HOUR, maxBatch: 2})
    expect(due.map(w => w.id)).toEqual(['w1', 'w3']) // never-searched first, then stalest
  })

  it('excludes freshly searched, completed, and in-flight tracks', () => {
    const d = db({
      wantlist: [want('fresh'), want('done'), want('active'), want('failed')],
      searches: [
        search('fresh', '2026-07-05T11:30:00Z'), // 30 min ago — within interval
        search('failed', '2026-07-01T00:00:00Z'),
      ],
      jobs: [job('done', 'completed'), job('active', 'downloading'), job('failed', 'failed')],
    })
    const due = selectDueTracks(d, {now: NOW, intervalMs: 6 * HOUR, maxBatch: 10})
    // 'failed' job is terminal-but-not-completed → still eligible for re-search.
    expect(due.map(w => w.id)).toEqual(['failed'])
  })
})
