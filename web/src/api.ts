// Typed fetch client for the enhancer's local API.

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

export interface TransferRow {
  id: string
  username: string
  filename: string
  state: string
  sizeBytes: number
  bytesTransferred: number
  percent: number
}

export interface DownloadedFile {
  name: string
  relPath: string
  sizeBytes: number
  format: string
  createdMs: number
}

export interface IgnoredPeer {
  username: string
  addedAt: string
}

export interface WantlistTrack {
  id: string
  artist: string
  title: string
  remix: string | null
  lengthMs: number | null
  copyText: string | null
  addedAt: string
  lastJob: {status: string, updatedAt: string} | null
  lastSearch: {skipReason: string | null, candidateCount: number, ranAt: string} | null
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body != null ? {'Content-Type': 'application/json'} : {},
    ...init,
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json() as {error?: string}
      if (body.error) message = body.error
    } catch { /* non-JSON error body */ }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return await res.json() as T
}

// --- manual search + download ---

export const startSearch = (query: string) =>
  request<{searchId: string}>('/api/searches', {method: 'POST', body: JSON.stringify({query})})

export const pollSearch = (searchId: string) =>
  request<{complete: boolean, candidates: ManualCandidate[]}>(`/api/searches/${encodeURIComponent(searchId)}`)

export const enqueueDownload = (c: {username: string, filename: string, sizeBytes: number}) =>
  request<{status: string}>('/api/downloads', {method: 'POST', body: JSON.stringify(c)})

export const cancelDownload = (username: string, id: string, remove: boolean) =>
  request<void>(`/api/downloads?username=${encodeURIComponent(username)}&id=${encodeURIComponent(id)}&remove=${remove}`, {method: 'DELETE'})

export const listTransfers = () => request<{transfers: TransferRow[]}>('/api/downloads')

export const listDownloadedFiles = () => request<{files: DownloadedFile[]}>('/api/downloads/files')

// --- ignored peers ---

export const listIgnoredPeers = async () => (await request<{peers: IgnoredPeer[]}>('/api/ignored-peers')).peers

export const addIgnoredPeer = (username: string) =>
  request<IgnoredPeer>('/api/ignored-peers', {method: 'POST', body: JSON.stringify({username})})

export const removeIgnoredPeer = (username: string) =>
  request<void>(`/api/ignored-peers/${encodeURIComponent(username)}`, {method: 'DELETE'})

// --- wantlist ---

export const listWantlist = async () => (await request<{tracks: WantlistTrack[]}>('/api/wantlist')).tracks

// --- CSV mapping ---

export type CsvRole = 'artist' | 'title' | 'remix' | 'length' | 'copyText'
export type CsvMapping = Record<CsvRole, string | null>

export interface CsvPreview {
  headers: Array<{raw: string, key: string}>
  sampleRows: string[][]
  autoMapping: CsvMapping
}

export const previewWantlistCsv = (csv: string) =>
  request<CsvPreview>('/api/wantlist/preview', {method: 'POST', body: JSON.stringify({csv})})

export const importWantlistCsv = (csv: string, mapping?: CsvMapping) =>
  request<{imported: number, errors: string[]}>('/api/wantlist/import', {method: 'POST', body: JSON.stringify({csv, mapping})})

// --- settings ---

export interface CleaningRule {
  find: string
  replace: string
  regex: boolean
  caseInsensitive: boolean
}

export type Tier = 'flac' | 'wav' | 'aiff' | 'mp3-320-plus' | 'mp3-192-plus'

export interface Settings {
  ranker: {
    enabledTiers: Tier[]
    mp3HighKbps: number
    mp3FloorKbps: number
    lengthToleranceMs: number
  }
  scheduler: {enabled: boolean, intervalHours: number}
  cleaningRules: CleaningRule[]
  csvMapping: CsvMapping | null
  soulseek: {username: string, password: string}
}

export const getSettings = () => request<Settings>('/api/settings')

export const putSettings = (patch: Partial<Settings>) =>
  request<Settings & {slskdRestartRequired: boolean}>('/api/settings', {method: 'PUT', body: JSON.stringify(patch)})

export const addWantlistTrack = (t: {artist: string, title: string, remix?: string}) =>
  request<WantlistTrack>('/api/wantlist', {method: 'POST', body: JSON.stringify(t)})

export const removeWantlistTrack = (id: string) =>
  request<void>(`/api/wantlist/${encodeURIComponent(id)}`, {method: 'DELETE'})

export const startAutoDownload = (id: string) =>
  request<{status: string}>(`/api/wantlist/${encodeURIComponent(id)}/download`, {method: 'POST'})
