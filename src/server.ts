// The enhancer's HTTP surface: a thin local API over the toolkit + JSON stores.
//
// Two download paths, mirroring the toolkit's design:
//   - MANUAL: the browser drives search → poll → pick a candidate → enqueue.
//     Stateless (nothing persisted); the peer blacklist only hides rows in the UI.
//   - AUTO (wantlist): `orchestrateTrack` runs the full pipeline — search, rank,
//     persist to the JSON stores, parallel-trigger download — with the peer
//     blacklist ENFORCED through the `IgnoredPeerStore` port.
//
// No auth: the server binds to loopback by default and is single-user by design.

import Fastify, {type FastifyInstance, type FastifyReply} from 'fastify'
import fastifyStatic from '@fastify/static'
import {readdir, stat} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {join, resolve} from 'node:path'
import * as z from 'zod'
import {
  orchestrateTrack,
  reconcileNonTerminalJobs,
  runPool,
  type OrchestratorDeps,
  type SlskdClient,
  type SlskdResponse,
  type TrackOutcome,
} from '@cratepilot/soulseek-toolkit'
import {parseWantlistCsv, previewCsv} from './csv.js'
import {
  csvMappingSchema,
  toRankerConfig,
  updateSettingsSchema,
  withDefaults,
  type Settings,
} from './settings.js'
import {selectDueTracks} from './scheduler.js'
import type {JsonDb, WantlistRecord} from './store/json-db.js'
import type {JsonIgnoredPeerStore, JsonJobStore, JsonSearchStore} from './store/stores.js'

// --- candidate shaping (manual search path) ---

/** Audio extensions surfaced in search results. */
const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'wav', 'aiff', 'aif', 'm4a'])

/** Format-quality order for sorting (lossless first). Lower = better. */
const FORMAT_RANK: Record<string, number> = {flac: 0, aiff: 1, aif: 1, wav: 2, m4a: 3, mp3: 4}

/** Max candidate rows returned to the client (keeps the payload bounded). */
const MAX_CANDIDATES = 250

export interface ManualCandidate {
  username: string
  filename: string
  format: string
  sizeBytes: number
  bitrateKbps: number | null
  lengthSeconds: number | null
  hasFreeUploadSlot: boolean
  queueLength: number
}

function extOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Flatten slskd responses → audio candidates, best-first, capped. */
export function shapeCandidates(responses: SlskdResponse[]): ManualCandidate[] {
  const rows: ManualCandidate[] = []
  for (const r of responses) {
    for (const f of r.files) {
      const format = extOf(f.filename)
      if (!AUDIO_EXTENSIONS.has(format)) continue
      rows.push({
        username:          r.username,
        filename:          f.filename,
        format,
        sizeBytes:         f.size,
        bitrateKbps:       f.bitRate ?? null,
        lengthSeconds:     f.length ?? null,
        hasFreeUploadSlot: r.hasFreeUploadSlot,
        queueLength:       r.queueLength,
      })
    }
  }
  rows.sort((a, b) => {
    // Free upload slot first (download starts immediately), then format quality,
    // then higher bitrate, then larger file.
    if (a.hasFreeUploadSlot !== b.hasFreeUploadSlot) return a.hasFreeUploadSlot ? -1 : 1
    const fr = (FORMAT_RANK[a.format] ?? 9) - (FORMAT_RANK[b.format] ?? 9)
    if (fr !== 0) return fr
    if ((b.bitrateKbps ?? 0) !== (a.bitrateKbps ?? 0)) return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0)
    return b.sizeBytes - a.sizeBytes
  })
  return rows.slice(0, MAX_CANDIDATES)
}

// --- downloaded-files scan ---

/** Backstop on files collected, so a pathological tree can't hang the scan. */
const DOWNLOADS_SCAN_CAP = 20_000
/** Most-recent files returned to the client. */
const DOWNLOADS_RETURN_LIMIT = 300

interface DownloadedFile {
  name: string
  relPath: string
  sizeBytes: number
  format: string
  createdMs: number
}

/**
 * Recursively list audio files under the downloads root — the durable record of
 * completed downloads (slskd prunes its in-memory transfer list). Newest first.
 */
async function scanDownloadedFiles(root: string): Promise<DownloadedFile[]> {
  const out: DownloadedFile[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (out.length >= DOWNLOADS_SCAN_CAP) return
    const entries = await readdir(dir, {withFileTypes: true}).catch(() => null)
    if (!entries) return
    for (const e of entries) {
      if (out.length >= DOWNLOADS_SCAN_CAP) return
      if (e.name.startsWith('.')) continue
      const abs = join(dir, e.name)
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        await walk(abs, childRel)
      } else if (e.isFile() && AUDIO_EXTENSIONS.has(extOf(e.name))) {
        try {
          const s = await stat(abs)
          const createdMs = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs
          out.push({name: e.name, relPath: childRel, sizeBytes: s.size, format: extOf(e.name), createdMs})
        } catch {
          // vanished between readdir and stat — skip
        }
      }
    }
  }
  await walk(root, '')
  out.sort((a, b) => b.createdMs - a.createdMs)
  return out.slice(0, DOWNLOADS_RETURN_LIMIT)
}

// --- request schemas ---

const searchBodySchema = z.object({query: z.string().trim().min(1, 'query is required')})
const downloadBodySchema = z.object({
  username: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
})
const peerBodySchema = z.object({username: z.string().trim().min(1, 'username is required')})
const importBodySchema = z.object({
  csv: z.string().min(1, 'csv is required'),
  /** Explicit column mapping from the import dialog; omitted = auto-detect. */
  mapping: csvMappingSchema.nullable().optional(),
})
const previewBodySchema = z.object({csv: z.string().min(1, 'csv is required')})
const addTrackBodySchema = z.object({
  artist: z.string().trim().min(1),
  title: z.string().trim().min(1),
  remix: z.string().trim().optional(),
  lengthMs: z.number().int().positive().nullable().optional(),
})

// --- server ---

export interface ServerOpts {
  slskd: SlskdClient
  /** Orchestrator deps minus the logger — the server wires its own pino in. */
  deps: Omit<OrchestratorDeps, 'logger'>
  db: JsonDb
  jobs: JsonJobStore
  searches: JsonSearchStore
  ignoredPeers: JsonIgnoredPeerStore
  downloadsRoot: string
  /** Absolute path of the built web UI (served statically when present). */
  webRoot?: string
}

export function buildServer(opts: ServerOpts): FastifyInstance {
  const app = Fastify({logger: true})
  const {slskd, db, jobs, searches, ignoredPeers} = opts
  // Fastify's pino logger satisfies the toolkit's structural Logger subset.
  const deps: OrchestratorDeps = {
    ...opts.deps,
    logger: app.log as unknown as OrchestratorDeps['logger'],
  }

  const getSettings = (): Settings => withDefaults(db.data.settings)

  /** Deps for a pipeline run, with the CURRENT ranker settings applied. */
  const depsForRun = (): OrchestratorDeps => ({
    ...deps,
    config: {...deps.config, rankerConfig: toRankerConfig(getSettings())},
  })

  function sendSlskdError(reply: FastifyReply, err: unknown): FastifyReply {
    const message = err instanceof Error ? err.message : String(err)
    app.log.warn({err: message}, 'slskd proxy error')
    // slskd answers 409 when it is running but NOT logged into the Soulseek
    // network (first run, wrong credentials, or dropped connection).
    if (message.includes(' 409 ')) {
      return reply.status(409).send({error: 'Not connected to the Soulseek network — enter your Soulseek login in Settings and restart the app'})
    }
    if (message.includes(' 401 ')) {
      return reply.status(502).send({error: 'slskd rejected the API key — check SLSKD_API_KEY'})
    }
    return reply.status(502).send({error: 'Soulseek daemon unreachable — check slskd is running'})
  }

  /** Fire-and-forget background task; errors are logged, never thrown. */
  function runInBackground(label: string, fn: () => Promise<void>): void {
    void fn().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      app.log.error({label, err: message}, 'background task failed')
    })
  }

  app.get('/api/health', async () => ({status: 'ok'}))

  // --- manual search + download (stateless proxy) ---

  app.post('/api/searches', async (request, reply) => {
    const parsed = searchBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({error: parsed.error.issues[0]?.message})
    try {
      const created = await slskd.search(parsed.data.query)
      return await reply.send({searchId: created.id})
    } catch (err) {
      return sendSlskdError(reply, err)
    }
  })

  app.get<{Params: {searchId: string}}>('/api/searches/:searchId', async (request, reply) => {
    try {
      const [state, responses] = await Promise.all([
        slskd.getSearchState(request.params.searchId),
        slskd.getResponses(request.params.searchId),
      ])
      return await reply.send({
        searchId: request.params.searchId,
        complete: state.isComplete,
        candidates: shapeCandidates(responses),
      })
    } catch (err) {
      return sendSlskdError(reply, err)
    }
  })

  app.post('/api/downloads', async (request, reply) => {
    const parsed = downloadBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({error: 'username, filename and sizeBytes are required'})
    const {username, filename, sizeBytes} = parsed.data
    try {
      await slskd.enqueueDownload(username, [{filename, size: sizeBytes}])
      return await reply.status(202).send({status: 'queued'})
    } catch (err) {
      return sendSlskdError(reply, err)
    }
  })

  app.delete<{Querystring: {username?: string, id?: string, remove?: string}}>(
    '/api/downloads',
    async (request, reply) => {
      const {username, id} = request.query
      if (!username || !id) return reply.status(400).send({error: 'username and id are required'})
      try {
        await slskd.cancelTransfer(username, id, {remove: request.query.remove === 'true'})
        return await reply.status(204).send()
      } catch (err) {
        return sendSlskdError(reply, err)
      }
    },
  )

  // Global transfer progress across all peers.
  app.get('/api/downloads', async (_request, reply) => {
    try {
      const peers = await slskd.listAllDownloads()
      const transfers = peers.flatMap((p) => p.transfers.map((t) => ({
        id: t.id,
        username: p.username,
        filename: t.filename,
        state: t.state,
        sizeBytes: t.size,
        bytesTransferred: t.bytesTransferred,
        percent: t.size > 0 ? Math.min(100, Math.round((t.bytesTransferred / t.size) * 100)) : 0,
      })))
      return await reply.send({transfers})
    } catch (err) {
      return sendSlskdError(reply, err)
    }
  })

  // Completed downloads present on disk (durable; survives slskd pruning).
  app.get('/api/downloads/files', async (_request, reply) => {
    const files = await scanDownloadedFiles(opts.downloadsRoot)
    return reply.send({files})
  })

  // --- ignored peers (the blacklist behind the IgnoredPeerStore port) ---

  app.get('/api/ignored-peers', async () => ({peers: ignoredPeers.list()}))

  app.post('/api/ignored-peers', async (request, reply) => {
    const parsed = peerBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({error: parsed.error.issues[0]?.message})
    const item = await ignoredPeers.add(parsed.data.username)
    return reply.status(201).send(item)
  })

  app.delete<{Params: {username: string}}>('/api/ignored-peers/:username', async (request, reply) => {
    await ignoredPeers.remove(request.params.username)
    return reply.status(204).send()
  })

  // --- wantlist (CSV import + auto-download) ---

  app.get('/api/wantlist', async () => {
    const jobByTrack = jobs.latestByTrack()
    const searchByTrack = searches.latestByTrack()
    return {
      tracks: db.data.wantlist.map((w) => ({
        ...w,
        lastJob: jobByTrack.get(w.id) ?? null,
        lastSearch: searchByTrack.get(w.id) ?? null,
      })),
    }
  })

  app.post('/api/wantlist', async (request, reply) => {
    const parsed = addTrackBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({error: 'artist and title are required'})
    const {artist, title, remix, lengthMs} = parsed.data
    const record = {
      id: db.nextId('want'),
      artist,
      title,
      remix: remix && remix !== '' ? remix : null,
      lengthMs: lengthMs ?? null,
      copyText: null,
      addedAt: new Date().toISOString(),
    }
    db.data.wantlist.push(record)
    await db.save()
    return reply.status(201).send(record)
  })

  // Inspect a CSV before import: headers, sample rows, auto-detected mapping.
  app.post('/api/wantlist/preview', async (request, reply) => {
    const parsed = previewBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({error: parsed.error.issues[0]?.message})
    const preview = previewCsv(parsed.data.csv)
    if ('error' in preview) return reply.status(400).send({error: preview.error})
    // Pre-fill with the saved mapping where its headers still exist in this file.
    const saved = getSettings().csvMapping
    if (saved !== null) {
      const keys = new Set(preview.headers.map((h) => h.key))
      for (const role of ['artist', 'title', 'remix', 'length', 'copyText'] as const) {
        const header = saved[role]
        if (header !== null && keys.has(header)) preview.autoMapping[role] = header
      }
    }
    return reply.send(preview)
  })

  app.post('/api/wantlist/import', async (request, reply) => {
    const parsed = importBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({error: parsed.error.issues[0]?.message})
    const settings = getSettings()
    const result = parseWantlistCsv(parsed.data.csv, {
      mapping: parsed.data.mapping ?? null,
      rules: settings.cleaningRules,
    })
    // Remember an explicit mapping so the next import pre-fills it.
    if (parsed.data.mapping != null) {
      db.data.settings = {...settings, csvMapping: parsed.data.mapping}
    }
    for (const row of result.rows) {
      db.data.wantlist.push({
        id: db.nextId('want'),
        artist: row.artist,
        title: row.title,
        remix: row.remix,
        lengthMs: row.lengthMs,
        copyText: row.copyText,
        addedAt: new Date().toISOString(),
      })
    }
    if (result.rows.length > 0 || parsed.data.mapping != null) await db.save()
    return reply.send({imported: result.rows.length, errors: result.errors})
  })

  app.delete<{Params: {id: string}}>('/api/wantlist/:id', async (request, reply) => {
    const before = db.data.wantlist.length
    db.data.wantlist = db.data.wantlist.filter((w) => w.id !== request.params.id)
    if (db.data.wantlist.length !== before) await db.save()
    return reply.status(204).send()
  })

  // AUTO path: full toolkit pipeline for one wantlist track — search, rank,
  // persist, parallel-trigger download. The peer blacklist is enforced here via
  // the IgnoredPeerStore port. Replies 202 immediately; the UI polls status.
  app.post<{Params: {id: string}}>('/api/wantlist/:id/download', async (request, reply) => {
    const track = db.data.wantlist.find((w) => w.id === request.params.id)
    if (track === undefined) return reply.status(404).send({error: 'wantlist track not found'})
    runInBackground(`auto-download ${track.id}`, async () => {
      const outcome: TrackOutcome = await runTrackPipeline(track)
      app.log.info({outcome}, 'auto-download finished')
    })
    return reply.status(202).send({status: 'started'})
  })

  /** One wantlist track through the full pipeline with current settings. */
  async function runTrackPipeline(track: WantlistRecord): Promise<TrackOutcome> {
    return orchestrateTrack(depsForRun(), {
      trackId: track.id,
      artist: track.artist,
      title: track.title,
      remix: track.remix,
      copyText: track.copyText,
      lengthMs: track.lengthMs,
    })
  }

  // --- settings ---

  app.get('/api/settings', async () => getSettings())

  app.put('/api/settings', async (request, reply) => {
    const parsed = updateSettingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({error: parsed.error.issues[0]?.message ?? 'invalid settings'})
    }
    const current = getSettings()
    const next: Settings = {
      ranker: parsed.data.ranker ?? current.ranker,
      scheduler: parsed.data.scheduler ?? current.scheduler,
      cleaningRules: parsed.data.cleaningRules ?? current.cleaningRules,
      csvMapping: parsed.data.csvMapping !== undefined ? parsed.data.csvMapping : current.csvMapping,
      soulseek: parsed.data.soulseek ?? current.soulseek,
    }
    const slskdRestartRequired =
      next.soulseek.username !== current.soulseek.username ||
      next.soulseek.password !== current.soulseek.password
    db.data.settings = next
    await db.save()
    return reply.send({...next, slskdRestartRequired})
  })

  // Startup + periodic reconcile keeps job statuses honest across restarts.
  // The scheduler tick re-searches unresolved wantlist tracks when (and only
  // when) the user has enabled it in Settings — manual-only by default.
  const SCHEDULER_TICK_MS = 15 * 60 * 1000
  const SCHEDULER_MAX_BATCH = 3

  async function schedulerTick(): Promise<void> {
    const settings = getSettings()
    if (!settings.scheduler.enabled) return
    const due = selectDueTracks(db.data, {
      now: new Date(),
      intervalMs: settings.scheduler.intervalHours * 60 * 60 * 1000,
      maxBatch: SCHEDULER_MAX_BATCH,
    })
    if (due.length === 0) return
    app.log.info({tracks: due.map(t => t.id)}, 'scheduler: re-searching due wantlist tracks')
    // One at a time — the per-track pipeline already fans out internally.
    await runPool(due, 1, async (track) => {
      const outcome = await runTrackPipeline(track)
      app.log.info({outcome}, 'scheduler: track finished')
    })
  }

  app.addHook('onReady', async () => {
    runInBackground('reconcile', async () => {
      await reconcileNonTerminalJobs(deps)
    })
    const reconcileTimer = setInterval(() => {
      runInBackground('reconcile', async () => {
        await reconcileNonTerminalJobs(deps)
      })
    }, 10 * 60 * 1000)
    reconcileTimer.unref?.()
    const schedulerTimer = setInterval(() => {
      runInBackground('scheduler', schedulerTick)
    }, SCHEDULER_TICK_MS)
    schedulerTimer.unref?.()
    app.addHook('onClose', async () => {
      clearInterval(reconcileTimer)
      clearInterval(schedulerTimer)
    })
  })

  // --- static UI (built web app), with an SPA fallback ---

  const webRoot = opts.webRoot ?? resolve('web/dist')
  if (existsSync(webRoot)) {
    void app.register(fastifyStatic, {root: webRoot})
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({error: 'not found'})
      return reply.sendFile('index.html')
    })
  }

  return app
}
