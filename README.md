# soulseek-enhancer

Personal Soulseek download manager on top of [slskd](https://github.com/slskd/slskd): wantlist-driven automatic downloads with quality ranking, a global peer blacklist, CSV import with configurable column mapping and cleaning rules, an optional re-search scheduler, and a manual search UI. Built on [`@cratepilot/soulseek-toolkit`](https://github.com/cratepilot/soulseek-toolkit).

Download-only by design — tagging/file management is out of scope.

## Desktop app (macOS / Windows)

Grab the installer from **GitHub Releases**. It is fully standalone: slskd is bundled inside the app and started for you. **No Docker, no separate slskd install.** (Docker is only mentioned below, under *Running from source*, for developers.)

1. Install the app. **The builds are unsigned** (pseudonymous publisher — use at your own discretion), so the OS pushes back once:
   - **macOS** reports the app as "damaged" until you clear the download-quarantine flag. Drag the app to Applications, then run in Terminal:
     ```
     xattr -cr "/Applications/Soulseek Enhancer.app"
     ```
     and open it normally.
   - **Windows**: at the SmartScreen prompt click *More info → Run anyway*.
2. Go to **Settings → Soulseek login**, enter your Soulseek username/password, save, and restart the app. The bundled slskd (on its own port, 5031, so it never clashes with an existing slskd) logs in with them. If the daemon ever misbehaves, its log is at `~/Library/Application Support/Soulseek Enhancer/slskd/slskd.log` (macOS) / `%APPDATA%/Soulseek Enhancer/slskd/slskd.log` (Windows).
3. Downloads land in `~/Downloads/Soulseek Enhancer/`.

To build installers yourself: `npm run dist` (or push a `v*` tag — the release workflow builds mac arm64/x64 + Windows with bundled slskd).

## How it works

Two download paths:

- **Manual (Search tab):** type a query, browse ranked candidates (lossless first, free-upload-slot peers first), download the exact file you pick. Stateless.
- **Auto (Wantlist tab):** import a CSV of tracks, hit *Auto-download* on a row — the toolkit pipeline searches, ranks by format/bitrate/length (per your **Settings → Formats & quality**), persists every candidate, and race-downloads the best ones until a winner completes. **Blacklisted peers are never auto-downloaded from.**
- **Scheduler (Settings, off by default):** when enabled, unresolved wantlist tracks are automatically re-searched no more often than your chosen interval, a few at a time. With it off, nothing ever downloads unless you click.

State lives in a single JSON file (`data/enhancer-db.json`) — no database.

## CSV import

Any CSV with a header row works — the import dialog previews the file and lets you **map each column to a role** (mapping is remembered for next time):

- **Artist**, **Title** — required
- **Remix** — optional
- **Length** — optional; `m:ss`, seconds, or milliseconds (improves ranking accuracy)
- **Search text override** — optional pre-normalized query used instead of artist/title

Files whose headers are literally `artist,title,remix,length,copy_text` map automatically.

**Cleaning rules** (Settings) are find/replace transformations — literal or regex — applied in order to the text fields at import time, e.g. strip ` (Original Mix)` or a label suffix your export tool adds.

## Running from source (developers only)

If you installed the desktop app, skip this section — it already includes slskd.

When running from source there is no bundled slskd, so you must run one yourself:

1. Run slskd. The easiest way is Docker: see the toolkit's `infra/docker-compose.slskd.yml` for a ready recipe with a reconnect watchdog. A native slskd install works too. **Bind slskd's downloads folder to a host path** and point `SLSK_DOWNLOADS_ROOT` at it — the enhancer reads completed files from disk.
2. Configure and start:

```bash
export SLSKD_BASE_URL=http://127.0.0.1:5030
export SLSKD_API_KEY=<your slskd api key>
export SLSK_DOWNLOADS_ROOT=/path/to/slskd/downloads

npm install
npm run build
npm start          # serves UI + API on http://127.0.0.1:5271
```

All env vars: `ENHANCER_HOST` (default `127.0.0.1` — loopback only; no auth, do not expose), `ENHANCER_PORT` (5271), `ENHANCER_DATA_DIR` (`./data`), `SLSK_DOWNLOADS_ROOT`, plus optional pipeline knobs (`SLSK_TRANSFER_POLL_MS`, `SLSK_STALL_THRESHOLD_MS`, `SLSK_SEARCH_TIMEOUT_MS`, `SLSK_SEARCH_POLL_MS`).

Dev mode: `npm run dev:server` + `npm run dev:web` (Vite on :5173 proxying `/api`).

> The toolkit dependency is `file:../soulseek-toolkit` (sibling checkout) until it is published to npm; it becomes `^0.1.0` then.

## End-to-end smoke check

With slskd running and logged in:

1. Blacklist a peer on the **Blacklist** tab.
2. Import a one-row CSV on the **Wantlist** tab, press **Auto-download**.
3. Watch the status move `searching… → matched/downloading → completed`; the file appears under **Downloads** and on disk. Candidates from the blacklisted peer are skipped by the pipeline (visible in the server log).

## Development

```bash
npm test        # stores, CSV contract, API routes (slskd stubbed)
npm run typecheck
```
