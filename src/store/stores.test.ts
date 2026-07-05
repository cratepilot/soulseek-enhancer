import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {Candidate} from '@cratepilot/soulseek-toolkit'
import {JsonDb} from './json-db.js'
import {JsonIgnoredPeerStore, JsonJobStore, JsonSearchStore} from './stores.js'

const USER = 'local'

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    peer: 'peer-a',
    filename: 'music\\Album\\track.flac',
    sizeBytes: 1000,
    fileLengthSeconds: 372,
    bitrateKbps: undefined,
    tier: 'flac',
    rank: 1,
    lengthDeltaMs: 0,
    ...overrides,
  }
}

let dir: string
let db: JsonDb

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'enhancer-store-'))
  db = await JsonDb.open(dir)
})

afterEach(async () => {
  await rm(dir, {recursive: true, force: true})
})

describe('JsonSearchStore', () => {
  it('persists a search with capped buckets and returns dbIds for ranked', async () => {
    const store = new JsonSearchStore(db)
    const rejected = Array.from({length: 250}, (_, i) => ({
      peer: 'p', filename: `f${i}.ogg`, sizeBytes: 1, fileLengthSeconds: undefined, bitrateKbps: undefined,
    }))
    const persisted = await store.insertSearchWithCandidates({
      userId: USER, trackId: 'want-1', queryText: 'q', slskdSearchId: 'slskd-1',
      ranked: [candidate()], rejected, locked: [], skipReason: null,
    })
    expect(persisted.candidates).toHaveLength(1)
    expect(persisted.candidates[0]?.dbId).toMatch(/^cand-/)
    const rec = db.data.searches[0]
    expect(rec?.candidates.filter(c => c.bucket === 'rejected')).toHaveLength(200) // capped
  })

  it('findLatestSlskdSearchId returns the newest non-null id for the track', async () => {
    const store = new JsonSearchStore(db)
    await store.insertSearchWithCandidates({
      userId: USER, trackId: 'want-1', queryText: 'q1', slskdSearchId: 'old',
      ranked: [], rejected: [], locked: [], skipReason: 'no_quality_match',
    })
    await store.insertFailedSearchRow({userId: USER, trackId: 'want-1', queryText: 'q2', skipReason: 'no_responses'})
    await store.insertSearchWithCandidates({
      userId: USER, trackId: 'want-1', queryText: 'q3', slskdSearchId: 'newest',
      ranked: [], rejected: [], locked: [], skipReason: 'no_quality_match',
    })
    expect(await store.findLatestSlskdSearchId({userId: USER, trackId: 'want-1'})).toBe('newest')
    expect(await store.findLatestSlskdSearchId({userId: USER, trackId: 'other'})).toBeNull()
  })
})

describe('JsonJobStore', () => {
  it('creates, mutates, and reloads jobs across a reopen (persistence)', async () => {
    const jobs = new JsonJobStore(db)
    const {id} = await jobs.createJobRow({
      userId: USER, trackId: 'want-1', trackSearchId: 's-1', candidateId: 'c-1',
      slskdSearchId: 'slskd-1', chosenUsername: 'peer-a', chosenFilename: 'f.flac',
      chosenFormat: 'flac', chosenBitrate: null, status: 'matched',
    })
    await jobs.setSlskdTransferId({userId: USER, id, slskdTransferId: 't-9'})
    await jobs.markCompleted({userId: USER, id, localFilePath: '/dl/f.flac', completedAt: new Date('2026-07-01T00:00:00Z')})

    const reopened = await JsonDb.open(dir)
    const row = reopened.data.jobs[0]
    expect(row).toMatchObject({id, status: 'completed', slskdTransferId: 't-9', localFilePath: '/dl/f.flac'})
  })

  it('findNonTerminalJobs joins the linked candidate and excludes terminal rows', async () => {
    const searches = new JsonSearchStore(db)
    const persisted = await searches.insertSearchWithCandidates({
      userId: USER, trackId: 'want-1', queryText: 'q', slskdSearchId: 'slskd-1',
      ranked: [candidate({sizeBytes: 4242})], rejected: [], locked: [], skipReason: null,
    })
    const jobs = new JsonJobStore(db)
    const {id} = await jobs.createJobRow({
      userId: USER, trackId: 'want-1', trackSearchId: persisted.id, candidateId: persisted.candidates[0]!.dbId,
      slskdSearchId: 'slskd-1', chosenUsername: 'peer-a', chosenFilename: 'f.flac',
      chosenFormat: 'flac', chosenBitrate: null, status: 'downloading',
    })
    await jobs.createJobRow({
      userId: USER, trackId: 'want-2', trackSearchId: 'sX', candidateId: 'cX',
      slskdSearchId: 'sX', chosenUsername: 'peer-b', chosenFilename: 'g.mp3',
      chosenFormat: 'mp3', chosenBitrate: 320, status: 'completed',
    })

    const nonTerminal = await jobs.findNonTerminalJobs(USER)
    expect(nonTerminal).toHaveLength(1)
    expect(nonTerminal[0]).toMatchObject({id, chosenUsername: 'peer-a'})
    expect(nonTerminal[0]?.candidate).toEqual({filename: 'music\\Album\\track.flac', sizeBytes: BigInt(4242)})
  })
})

describe('JsonIgnoredPeerStore', () => {
  it('add is idempotent; port returns a Set; remove persists', async () => {
    const store = new JsonIgnoredPeerStore(db)
    await store.add('bad-peer')
    await store.add('bad-peer')
    await store.add('worse-peer')
    expect(store.list()).toHaveLength(2)
    expect(await store.getIgnoredPeerUsernames()).toEqual(new Set(['bad-peer', 'worse-peer']))

    await store.remove('bad-peer')
    const reopened = new JsonIgnoredPeerStore(await JsonDb.open(dir))
    expect(await reopened.getIgnoredPeerUsernames()).toEqual(new Set(['worse-peer']))
  })
})
