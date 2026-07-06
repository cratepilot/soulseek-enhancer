// Electron main process: boots the bundled slskd (when packaged), starts the
// enhancer server in-process, and opens a window on it.
//
// Unsigned by design — users install at their own discretion (macOS:
// right-click → Open on first launch; Windows: SmartScreen → Run anyway).

import {join} from 'node:path'
import type {ChildProcess} from 'node:child_process'
import {app, BrowserWindow, dialog} from 'electron'
import {
  SLSKD_PORT,
  bundledSlskdPath,
  loadOrCreateApiKey,
  readStoredCredentials,
  spawnSlskd,
  waitForSlskd,
  writeSlskdConfig,
} from './slskd-manager.js'

const SERVER_PORT = 5271

let slskdChild: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
// null = external-slskd mode (no bundled binary); boolean = bundled spawn result.
let slskdHealthy: boolean | null = null

async function boot(): Promise<void> {
  const userData = app.getPath('userData')
  const dataDir = join(userData, 'data')
  const slskdAppDir = join(userData, 'slskd')
  const downloadsDir = join(app.getPath('downloads'), 'Soulseek Enhancer')
  const incompleteDir = join(slskdAppDir, 'incomplete')

  // --- bundled slskd (packaged builds only; dev talks to an external slskd) ---
  const apiKey = await loadOrCreateApiKey(slskdAppDir)
  const binary = bundledSlskdPath(process.resourcesPath)
  if (binary !== null) {
    const creds = await readStoredCredentials(dataDir)
    await writeSlskdConfig(
      {appDir: slskdAppDir, downloadsDir, incompleteDir, username: creds.username, password: creds.password},
      apiKey,
    )
    slskdChild = spawnSlskd(binary, slskdAppDir)
    slskdChild.on('exit', (code) => {
      console.warn(`slskd exited with code ${code}`)
    })
    slskdHealthy = await waitForSlskd(45_000)
    process.env['SLSKD_BASE_URL'] = `http://127.0.0.1:${SLSKD_PORT}`
    process.env['SLSKD_API_KEY'] = apiKey
  } else {
    // Dev / external-slskd mode: use whatever the environment provides.
    process.env['SLSKD_BASE_URL'] ??= 'http://127.0.0.1:5030'
    process.env['SLSKD_API_KEY'] ??= 'dev'
  }

  // --- enhancer server (in this process; fastify binds loopback only) ---
  const {startServer} = await import('../dist/index.js')
  await startServer({
    host: '127.0.0.1',
    port: SERVER_PORT,
    dataDir,
    downloadsRoot: downloadsDir,
    webRoot: join(app.getAppPath(), 'web', 'dist'),
  })

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Soulseek Enhancer',
    webPreferences: {contextIsolation: true, nodeIntegration: false},
  })
  await mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`)

  // Non-blocking: warn about a failed bundled slskd AFTER the UI is usable.
  if (slskdHealthy === false) {
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Bundled Soulseek daemon failed to start',
      message: `slskd did not come up within 45 s.\nSee the log at:\n${join(app.getPath('userData'), 'slskd', 'slskd.log')}`,
    })
  }
}

app.whenReady().then(boot).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  dialog.showErrorBox('Soulseek Enhancer failed to start', message)
  app.quit()
})

app.on('activate', () => {
  // macOS dock re-activate with no window: reopen on the running server.
  if (mainWindow === null && BrowserWindow.getAllWindows().length === 0) {
    mainWindow = new BrowserWindow({width: 1200, height: 820, title: 'Soulseek Enhancer'})
    void mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`)
  }
})

app.on('window-all-closed', () => {
  app.quit() // single-window utility app: closing the window quits (all platforms)
})

app.on('before-quit', () => {
  slskdChild?.kill()
})
