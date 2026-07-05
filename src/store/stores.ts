// JSON-backed implementations of the toolkit's persistence ports.
//
// These are the enhancer's counterparts to a DB-backed store: `JobStore`,
// `SearchStore`, and `IgnoredPeerStore` over the single-file `JsonDb`. The
// orchestrator (auto-download path) consumes them through the port interfaces,
// which keeps the peer-blacklist rule active exactly as the toolkit defines it.

import type {
  CreateJobArgs,
  DownloadJobStatus,
  IgnoredPeerStore,
  InsertFailedSearchArgs,
  InsertSearchArgs,
  JobStore,
  PersistedSearch,
  ReconcileJobRow,
  SearchStore,
} from '@cratepilot/soulseek-toolkit'
import type {CandidateRecord, JsonDb} from './json-db.js'

// Mirror of the DB-bloat caps used by the reference implementation: the rejected
// bucket can be huge (everything slskd returned); locked is always small.
const REJECTED_PERSIST_CAP = 200
const LOCKED_PERSIST_CAP = 50

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped', 'deleted'])

export class JsonJobStore implements JobStore {
  constructor(private readonly db: JsonDb) {}

  private byId(id: string) {
    const row = this.db.data.jobs.find(j => j.id === id)
    if (row === undefined) throw new Error(`JsonJobStore: no job with id ${id}`)
    return row
  }

  async createJobRow(args: CreateJobArgs): Promise<{id: string}> {
    const id = this.db.nextId('job')
    this.db.data.jobs.push({
      id,
      userId: args.userId,
      trackId: args.trackId,
      trackSearchId: args.trackSearchId,
      candidateId: args.candidateId,
      slskdSearchId: args.slskdSearchId,
      chosenUsername: args.chosenUsername,
      chosenFilename: args.chosenFilename,
      chosenFormat: args.chosenFormat,
      chosenBitrate: args.chosenBitrate,
      status: args.status,
      slskdTransferId: null,
      localFilePath: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
    })
    await this.db.save()
    return {id}
  }

  async updateJobStatus(args: {userId: string, id: string, status: DownloadJobStatus}): Promise<void> {
    const row = this.byId(args.id)
    row.status = args.status
    row.updatedAt = new Date().toISOString()
    await this.db.save()
  }

  async setSlskdTransferId(args: {userId: string, id: string, slskdTransferId: string}): Promise<void> {
    const row = this.byId(args.id)
    row.slskdTransferId = args.slskdTransferId
    row.updatedAt = new Date().toISOString()
    await this.db.save()
  }

  async markCompleted(args: {userId: string, id: string, localFilePath: string, completedAt: Date}): Promise<void> {
    const row = this.byId(args.id)
    row.status = 'completed'
    row.localFilePath = args.localFilePath
    row.completedAt = args.completedAt.toISOString()
    row.updatedAt = new Date().toISOString()
    await this.db.save()
  }

  async findNonTerminalJobs(ownerUserId: string): Promise<ReconcileJobRow[]> {
    return this.db.data.jobs
      .filter(j => j.userId === ownerUserId && !TERMINAL_STATUSES.has(j.status))
      .map(j => {
        const candidate = this.db.data.searches
          .find(s => s.id === j.trackSearchId)?.candidates
          .find(c => c.id === j.candidateId)
        return {
          id: j.id,
          status: j.status,
          chosenUsername: j.chosenUsername,
          slskdTransferId: j.slskdTransferId,
          updatedAt: new Date(j.updatedAt),
          candidate: candidate
            ? {filename: candidate.filename, sizeBytes: BigInt(candidate.sizeBytes)}
            : null,
        }
      })
  }

  /** Latest job per trackId (for the wantlist status column). Not part of the port. */
  latestByTrack(): Map<string, {status: string, updatedAt: string}> {
    const out = new Map<string, {status: string, updatedAt: string}>()
    for (const j of this.db.data.jobs) {
      const prev = out.get(j.trackId)
      if (prev === undefined || j.updatedAt > prev.updatedAt) {
        out.set(j.trackId, {status: j.status, updatedAt: j.updatedAt})
      }
    }
    return out
  }
}

export class JsonSearchStore implements SearchStore {
  constructor(private readonly db: JsonDb) {}

  async findLatestSlskdSearchId(args: {userId: string, trackId: string}): Promise<string | null> {
    for (let i = this.db.data.searches.length - 1; i >= 0; i--) {
      const s = this.db.data.searches[i]
      if (s !== undefined && s.userId === args.userId && s.trackId === args.trackId && s.slskdSearchId !== null) {
        return s.slskdSearchId
      }
    }
    return null
  }

  async insertSearchWithCandidates(args: InsertSearchArgs): Promise<PersistedSearch> {
    const id = this.db.nextId('search')
    const passed: CandidateRecord[] = args.ranked.map(c => ({
      id: this.db.nextId('cand'),
      bucket: 'passed',
      peer: c.peer,
      filename: c.filename,
      sizeBytes: c.sizeBytes,
      fileLengthSeconds: c.fileLengthSeconds ?? null,
      bitrateKbps: c.bitrateKbps ?? null,
      tier: c.tier,
      rank: c.rank,
      lengthDeltaMs: c.lengthDeltaMs ?? null,
    }))
    const shapeRaw = (bucket: 'rejected' | 'locked') => (c: InsertSearchArgs['rejected'][number]): CandidateRecord => ({
      id: this.db.nextId('cand'),
      bucket,
      peer: c.peer,
      filename: c.filename,
      sizeBytes: c.sizeBytes,
      fileLengthSeconds: c.fileLengthSeconds ?? null,
      bitrateKbps: c.bitrateKbps ?? null,
      tier: null,
      rank: null,
      lengthDeltaMs: null,
    })
    const rejected = args.rejected.slice(0, REJECTED_PERSIST_CAP).map(shapeRaw('rejected'))
    const locked = args.locked.slice(0, LOCKED_PERSIST_CAP).map(shapeRaw('locked'))

    this.db.data.searches.push({
      id,
      userId: args.userId,
      trackId: args.trackId,
      queryText: args.queryText,
      slskdSearchId: args.slskdSearchId,
      skipReason: args.skipReason,
      triggeredBy: args.triggeredBy ?? 'auto',
      ranAt: new Date().toISOString(),
      candidates: [...passed, ...rejected, ...locked],
    })
    await this.db.save()
    return {
      id,
      candidates: args.ranked.map((c, i) => {
        const rec = passed[i]
        if (rec === undefined) throw new Error(`internal: candidate index ${i} missing after insert`)
        return {...c, dbId: rec.id}
      }),
    }
  }

  async insertFailedSearchRow(args: InsertFailedSearchArgs): Promise<{id: string}> {
    const id = this.db.nextId('search')
    this.db.data.searches.push({
      id,
      userId: args.userId,
      trackId: args.trackId,
      queryText: args.queryText,
      slskdSearchId: null,
      skipReason: args.skipReason,
      triggeredBy: args.triggeredBy ?? 'auto',
      ranAt: new Date().toISOString(),
      candidates: [],
    })
    await this.db.save()
    return {id}
  }

  /** Latest search per trackId (for the wantlist status column). Not part of the port. */
  latestByTrack(): Map<string, {skipReason: string | null, candidateCount: number, ranAt: string}> {
    const out = new Map<string, {skipReason: string | null, candidateCount: number, ranAt: string}>()
    for (const s of this.db.data.searches) {
      const prev = out.get(s.trackId)
      if (prev === undefined || s.ranAt > prev.ranAt) {
        out.set(s.trackId, {
          skipReason: s.skipReason,
          candidateCount: s.candidates.filter(c => c.bucket === 'passed').length,
          ranAt: s.ranAt,
        })
      }
    }
    return out
  }
}

export class JsonIgnoredPeerStore implements IgnoredPeerStore {
  constructor(private readonly db: JsonDb) {}

  async getIgnoredPeerUsernames(): Promise<Set<string>> {
    return new Set(this.db.data.ignoredPeers.map(p => p.username))
  }

  /** Newest first, for the management UI. Not part of the port. */
  list(): Array<{username: string, addedAt: string}> {
    return [...this.db.data.ignoredPeers].sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  }

  /** Idempotent add. Not part of the port. */
  async add(username: string): Promise<{username: string, addedAt: string}> {
    const existing = this.db.data.ignoredPeers.find(p => p.username === username)
    if (existing !== undefined) return existing
    const item = {username, addedAt: new Date().toISOString()}
    this.db.data.ignoredPeers.push(item)
    await this.db.save()
    return item
  }

  /** Not part of the port. */
  async remove(username: string): Promise<void> {
    const before = this.db.data.ignoredPeers.length
    this.db.data.ignoredPeers = this.db.data.ignoredPeers.filter(p => p.username !== username)
    if (this.db.data.ignoredPeers.length !== before) await this.db.save()
  }
}
