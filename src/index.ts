// Server bootstrap. Importable (`startServer`) for the desktop shell, and
// runnable directly (`node dist/index.js`) for the headless/server usage.

import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import type {FastifyInstance} from 'fastify'
import {createSlskdClient} from '@cratepilot/soulseek-toolkit'
import {loadEnv} from './config.js'
import {JsonDb} from './store/json-db.js'
import {JsonIgnoredPeerStore, JsonJobStore, JsonSearchStore} from './store/stores.js'
import {buildServer} from './server.js'

/** Single-user app — every store row is owned by this constant id. */
export const LOCAL_USER = 'local'

export interface StartOverrides {
  host?: string
  port?: number
  dataDir?: string
  downloadsRoot?: string
  /** Absolute path of the built web UI (the desktop shell passes its packaged path). */
  webRoot?: string
}

export interface RunningServer {
  app: FastifyInstance
  host: string
  port: number
}

/** Build + listen. Env provides defaults; `overrides` win (desktop shell). */
export async function startServer(overrides: StartOverrides = {}): Promise<RunningServer> {
  const env = loadEnv()
  const host = overrides.host ?? env.ENHANCER_HOST
  const port = overrides.port ?? env.ENHANCER_PORT
  const dataDir = resolve(overrides.dataDir ?? env.ENHANCER_DATA_DIR)
  const downloadsRoot = resolve(overrides.downloadsRoot ?? env.SLSK_DOWNLOADS_ROOT)

  const slskd = createSlskdClient() // validates SLSKD_BASE_URL / SLSKD_API_KEY itself
  const db = await JsonDb.open(dataDir)
  const jobs = new JsonJobStore(db)
  const searches = new JsonSearchStore(db)
  const ignoredPeers = new JsonIgnoredPeerStore(db)

  const app = buildServer({
    slskd,
    deps: {
      slskd,
      ownerUserId: LOCAL_USER,
      config: {
        dryRun: false,
        downloadsRoot,
        transferPollMs: env.SLSK_TRANSFER_POLL_MS,
        stallThresholdMs: env.SLSK_STALL_THRESHOLD_MS,
        searchTimeoutMs: env.SLSK_SEARCH_TIMEOUT_MS,
        searchPollMs: env.SLSK_SEARCH_POLL_MS,
      },
      jobs,
      searches,
      ignoredPeers,
    },
    db,
    jobs,
    searches,
    ignoredPeers,
    downloadsRoot,
    ...(overrides.webRoot !== undefined ? {webRoot: overrides.webRoot} : {}),
  })

  await app.listen({host, port})
  return {app, host, port}
}

// Run directly (not imported): `node dist/index.js`.
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  startServer().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
