// Single-file JSON persistence for the enhancer's stores.
//
// Deliberately not SQLite: a personal download manager writes a handful of rows
// per track, so a whole-file atomic rewrite (temp + rename, same directory) is
// plenty — zero native deps, trivially inspectable/backupable state.

import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import type {Settings} from '../settings.js'

/** One persisted download job (superset of the toolkit's ReconcileJobRow). */
export interface JobRecord {
  id: string
  userId: string
  trackId: string
  trackSearchId: string
  candidateId: string
  slskdSearchId: string
  chosenUsername: string | null
  chosenFilename: string
  chosenFormat: string
  chosenBitrate: number | null
  status: string
  slskdTransferId: string | null
  localFilePath: string | null
  completedAt: string | null
  /** ISO timestamp of the last mutation (drives the reconcile stale-age rule). */
  updatedAt: string
}

/** One persisted candidate row belonging to a search. */
export interface CandidateRecord {
  id: string
  bucket: 'passed' | 'rejected' | 'locked'
  peer: string
  filename: string
  sizeBytes: number
  fileLengthSeconds: number | null
  bitrateKbps: number | null
  tier: string | null
  rank: number | null
  lengthDeltaMs: number | null
}

/** One persisted search (with its capped candidate rows). */
export interface SearchRecord {
  id: string
  userId: string
  trackId: string
  queryText: string
  slskdSearchId: string | null
  skipReason: string | null
  triggeredBy: 'auto' | 'manual'
  ranAt: string
  candidates: CandidateRecord[]
}

/** One wantlist entry (imported from CSV or added manually). */
export interface WantlistRecord {
  id: string
  artist: string
  title: string
  remix: string | null
  lengthMs: number | null
  copyText: string | null
  addedAt: string
}

export interface DbShape {
  seq: number
  jobs: JobRecord[]
  searches: SearchRecord[]
  ignoredPeers: Array<{username: string, addedAt: string}>
  wantlist: WantlistRecord[]
  /** User settings; absent in dbs written before settings existed (defaults apply). */
  settings?: Partial<Settings>
}

const EMPTY: DbShape = {seq: 0, jobs: [], searches: [], ignoredPeers: [], wantlist: []}

/**
 * Loads the db file at construction (`open`), holds state in memory, and
 * persists atomically on every `save()`. Single-process by design.
 */
export class JsonDb {
  private constructor(
    private readonly filePath: string,
    readonly data: DbShape,
  ) {}

  static async open(dataDir: string): Promise<JsonDb> {
    const filePath = join(dataDir, 'enhancer-db.json')
    await mkdir(dataDir, {recursive: true})
    let data: DbShape
    try {
      const raw = await readFile(filePath, 'utf8')
      data = {...EMPTY, ...(JSON.parse(raw) as Partial<DbShape>)}
    } catch {
      data = structuredClone(EMPTY)
    }
    return new JsonDb(filePath, data)
  }

  /** Next sequential id with the given prefix (e.g. `job-7`). Persisted with the data. */
  nextId(prefix: string): string {
    this.data.seq += 1
    return `${prefix}-${this.data.seq}`
  }

  /** Atomic write: serialize to a same-directory temp file, then rename over. */
  async save(): Promise<void> {
    const tmp = join(dirname(this.filePath), '.enhancer-db.tmp.json')
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }
}
