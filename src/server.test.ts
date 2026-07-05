import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {FastifyInstance} from 'fastify'
import type {SlskdClient, SlskdResponse} from '@cratepilot/soulseek-toolkit'
import {JsonDb} from './store/json-db.js'
import {JsonIgnoredPeerStore, JsonJobStore, JsonSearchStore} from './store/stores.js'
import {buildServer, shapeCandidates} from './server.js'

const USER = 'local'

/** SlskdClient stub: every method throws unless overridden. */
function stubSlskd(overrides: Partial<SlskdClient>): SlskdClient {
  const reject = (name: string) => () => {
    throw new Error(`stubSlskd: unexpected call to ${name}`)
  }
  return {
    search: reject('search'),
    getSearchState: reject('getSearchState'),
    getResponses: reject('getResponses'),
    deleteSearch: reject('deleteSearch'),
    enqueueDownload: reject('enqueueDownload'),
    getTransfer: reject('getTransfer'),
    listDownloadsForUser: reject('listDownloadsForUser'),
    listAllDownloads: reject('listAllDownloads'),
    cancelTransfer: reject('cancelTransfer'),
    ...overrides,
  }
}

let dir: string
let db: JsonDb
let app: FastifyInstance

async function makeApp(slskd: SlskdClient): Promise<FastifyInstance> {
  const jobs = new JsonJobStore(db)
  const searches = new JsonSearchStore(db)
  const ignoredPeers = new JsonIgnoredPeerStore(db)
  return buildServer({
    slskd,
    deps: {
      slskd,
      ownerUserId: USER,
      config: {
        dryRun: false, downloadsRoot: dir,
        transferPollMs: 1, stallThresholdMs: 1000, searchTimeoutMs: 5000, searchPollMs: 1,
      },
      jobs, searches, ignoredPeers,
    },
    db, jobs, searches, ignoredPeers,
    downloadsRoot: dir,
    webRoot: join(dir, 'no-web'), // absent → static serving disabled in tests
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'enhancer-server-'))
  db = await JsonDb.open(dir)
})

afterEach(async () => {
  await app?.close()
  await rm(dir, {recursive: true, force: true})
})

describe('shapeCandidates', () => {
  it('filters non-audio, sorts free-slot > format > bitrate, and caps', () => {
    const responses: SlskdResponse[] = [
      {
        username: 'busy-peer', fileCount: 3, hasFreeUploadSlot: false, queueLength: 5, uploadSpeed: 1,
        files: [
          {filename: 'a\\track.flac', size: 100},
          {filename: 'a\\track.pdf', size: 5},
        ],
      },
      {
        username: 'free-peer', fileCount: 2, hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1,
        files: [
          {filename: 'b\\track.mp3', size: 50, bitRate: 320},
          {filename: 'b\\track2.mp3', size: 50, bitRate: 192},
        ],
      },
    ]
    const shaped = shapeCandidates(responses)
    expect(shaped.map(c => c.filename)).toEqual(['b\\track.mp3', 'b\\track2.mp3', 'a\\track.flac'])
    expect(shaped.every(c => c.format !== 'pdf')).toBe(true)
  })
})

describe('ignored peers API', () => {
  it('POST/GET/DELETE round-trip', async () => {
    app = await makeApp(stubSlskd({}))
    const created = await app.inject({method: 'POST', url: '/api/ignored-peers', payload: {username: 'bad-peer'}})
    expect(created.statusCode).toBe(201)

    const list = await app.inject({method: 'GET', url: '/api/ignored-peers'})
    expect(list.json()).toEqual({peers: [expect.objectContaining({username: 'bad-peer'})]})

    const removed = await app.inject({method: 'DELETE', url: '/api/ignored-peers/bad-peer'})
    expect(removed.statusCode).toBe(204)
    expect((await app.inject({method: 'GET', url: '/api/ignored-peers'})).json()).toEqual({peers: []})
  })

  it('rejects a blank username', async () => {
    app = await makeApp(stubSlskd({}))
    const res = await app.inject({method: 'POST', url: '/api/ignored-peers', payload: {username: '  '}})
    expect(res.statusCode).toBe(400)
  })
})

describe('wantlist API', () => {
  it('imports CSV rows, lists them with null statuses, deletes one', async () => {
    app = await makeApp(stubSlskd({}))
    const imported = await app.inject({
      method: 'POST', url: '/api/wantlist/import',
      payload: {csv: 'artist,title,length\nHot Since 82,Alive,6:12\n,missing artist,1:00\n'},
    })
    expect(imported.json()).toMatchObject({imported: 1})
    expect(imported.json().errors).toHaveLength(1)

    const list = await app.inject({method: 'GET', url: '/api/wantlist'})
    const tracks = list.json().tracks
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({artist: 'Hot Since 82', title: 'Alive', lengthMs: 372_000, lastJob: null, lastSearch: null})

    const del = await app.inject({method: 'DELETE', url: `/api/wantlist/${tracks[0].id}`})
    expect(del.statusCode).toBe(204)
    expect((await app.inject({method: 'GET', url: '/api/wantlist'})).json().tracks).toHaveLength(0)
  })

  it('auto-download runs the toolkit pipeline in the background (persists the search row)', async () => {
    // Both search POSTs fail → orchestrateTrack persists a no_responses failed
    // search and returns 'skipped' — fully deterministic without a live slskd.
    app = await makeApp(stubSlskd({
      search: async () => { throw new Error('slskd down') },
    }))
    await app.inject({method: 'POST', url: '/api/wantlist', payload: {artist: 'A', title: 'B'}})
    const id = (await app.inject({method: 'GET', url: '/api/wantlist'})).json().tracks[0].id as string

    const res = await app.inject({method: 'POST', url: `/api/wantlist/${id}/download`})
    expect(res.statusCode).toBe(202)

    // The pipeline retries once after 200 ms, then persists — poll briefly.
    await expectEventually(() => db.data.searches.length === 1, 3000)
    expect(db.data.searches[0]).toMatchObject({trackId: id, skipReason: 'no_responses', triggeredBy: 'auto'})

    const list = await app.inject({method: 'GET', url: '/api/wantlist'})
    expect(list.json().tracks[0].lastSearch).toMatchObject({skipReason: 'no_responses', candidateCount: 0})
  })

  it('404s an auto-download for an unknown wantlist id', async () => {
    app = await makeApp(stubSlskd({}))
    const res = await app.inject({method: 'POST', url: '/api/wantlist/nope/download'})
    expect(res.statusCode).toBe(404)
  })
})

describe('manual search + download API', () => {
  it('starts a search, polls candidates, enqueues a download', async () => {
    app = await makeApp(stubSlskd({
      search: async () => ({id: 'srch-1', searchText: 'q'}),
      getSearchState: async () => ({id: 'srch-1', searchText: 'q', state: 'Completed', fileCount: 1, responseCount: 1, isComplete: true}),
      getResponses: async () => ([{
        username: 'peer-a', fileCount: 1, hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1,
        files: [{filename: 'x\\y.flac', size: 77}],
      }]),
      enqueueDownload: async () => {},
    }))
    const started = await app.inject({method: 'POST', url: '/api/searches', payload: {query: 'daft punk'}})
    expect(started.json()).toEqual({searchId: 'srch-1'})

    const poll = await app.inject({method: 'GET', url: '/api/searches/srch-1'})
    expect(poll.json()).toMatchObject({complete: true})
    expect(poll.json().candidates[0]).toMatchObject({username: 'peer-a', format: 'flac', sizeBytes: 77})

    const dl = await app.inject({method: 'POST', url: '/api/downloads', payload: {username: 'peer-a', filename: 'x\\y.flac', sizeBytes: 77}})
    expect(dl.statusCode).toBe(202)
  })

  it('maps slskd transport failures to 502', async () => {
    app = await makeApp(stubSlskd({
      search: async () => { throw new Error('ECONNREFUSED') },
    }))
    const res = await app.inject({method: 'POST', url: '/api/searches', payload: {query: 'x'}})
    expect(res.statusCode).toBe(502)
  })
})

describe('settings API', () => {
  it('returns defaults, applies section updates, flags slskd restart on credential change', async () => {
    app = await makeApp(stubSlskd({}))
    const defaults = (await app.inject({method: 'GET', url: '/api/settings'})).json()
    expect(defaults.ranker).toMatchObject({mp3HighKbps: 320, mp3FloorKbps: 192, lengthToleranceMs: 2000})
    expect(defaults.scheduler).toEqual({enabled: false, intervalHours: 12})

    const updated = await app.inject({
      method: 'PUT', url: '/api/settings',
      payload: {
        ranker: {enabledTiers: ['flac', 'mp3-320-plus'], mp3HighKbps: 320, mp3FloorKbps: 256, lengthToleranceMs: 3000},
        soulseek: {username: 'someone', password: 'pw'},
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().slskdRestartRequired).toBe(true)
    expect(updated.json().scheduler).toEqual({enabled: false, intervalHours: 12}) // untouched section

    // Persisted: a reopened db sees the new ranker settings.
    const reopened = await JsonDb.open(dir)
    expect(reopened.data.settings?.ranker?.enabledTiers).toEqual(['flac', 'mp3-320-plus'])
  })

  it('rejects an invalid section (floor above high)', async () => {
    app = await makeApp(stubSlskd({}))
    const res = await app.inject({
      method: 'PUT', url: '/api/settings',
      payload: {ranker: {enabledTiers: ['flac'], mp3HighKbps: 192, mp3FloorKbps: 320, lengthToleranceMs: 2000}},
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('CSV preview + mapping + cleaning rules', () => {
  it('previews headers, sample rows, and auto-mapping', async () => {
    app = await makeApp(stubSlskd({}))
    const res = await app.inject({
      method: 'POST', url: '/api/wantlist/preview',
      payload: {csv: 'Interpret,Song Name,artist\nHot Since 82,Alive,x\n'},
    })
    const body = res.json()
    expect(body.headers.map((h: {key: string}) => h.key)).toEqual(['interpret', 'song_name', 'artist'])
    expect(body.sampleRows).toEqual([['Hot Since 82', 'Alive', 'x']])
    expect(body.autoMapping).toMatchObject({artist: 'artist', title: null})
  })

  it('imports with an explicit mapping, applies cleaning rules, and remembers the mapping', async () => {
    app = await makeApp(stubSlskd({}))
    await app.inject({
      method: 'PUT', url: '/api/settings',
      payload: {cleaningRules: [{find: ' (Original Mix)', replace: '', regex: false, caseInsensitive: true}]},
    })
    const res = await app.inject({
      method: 'POST', url: '/api/wantlist/import',
      payload: {
        csv: 'Interpret,Song Name\nHot Since 82,Alive (Original Mix)\n',
        mapping: {artist: 'interpret', title: 'song_name', remix: null, length: null, copyText: null},
      },
    })
    expect(res.json()).toMatchObject({imported: 1, errors: []})

    const list = (await app.inject({method: 'GET', url: '/api/wantlist'})).json()
    expect(list.tracks[0]).toMatchObject({artist: 'Hot Since 82', title: 'Alive'}) // rule stripped the suffix

    // Mapping remembered → preview pre-fills it next time.
    const preview = (await app.inject({
      method: 'POST', url: '/api/wantlist/preview',
      payload: {csv: 'Interpret,Song Name\nX,Y\n'},
    })).json()
    expect(preview.autoMapping).toMatchObject({artist: 'interpret', title: 'song_name'})
  })
})

/** Poll `cond` until true or `timeoutMs` elapses (then fail the assertion). */
async function expectEventually(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 25))
  }
  expect(cond()).toBe(true)
}
