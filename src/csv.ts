// CSV wantlist import — the row contract and a minimal RFC-4180 parser.
//
// Contract (documented in the README):
//   - Header row REQUIRED; headers are case-insensitive; column order is free;
//     unknown columns are ignored.
//   - DEFAULT (auto) mapping recognizes: artist (required), title (required),
//     remix, length (m:ss | seconds | milliseconds), copy_text.
//   - An EXPLICIT mapping (from the import dialog) can bind any header to any
//     role instead — that is how arbitrary CSV shapes are imported.
//   - Quoted fields support embedded commas/quotes/newlines ("" escapes a quote).
//   - Cleaning rules (user-defined find/replace) are applied to the text fields
//     at import time, in rule order.
//
// Parsing is total: bad rows are reported per-line, good rows still import.

import {applyCleaningRules, type CleaningRule, type CsvMapping} from './settings.js'

export interface WantlistRow {
  artist: string
  title: string
  remix: string | null
  lengthMs: number | null
  copyText: string | null
}

export interface CsvImportResult {
  rows: WantlistRow[]
  /** Per-line errors ("line 3: artist is required"). Line numbers are 1-based incl. header. */
  errors: string[]
}

/** Split raw CSV text into rows of fields, honoring quotes (RFC-4180). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0
  const pushField = (): void => { row.push(field); field = '' }
  const pushRow = (): void => { pushField(); rows.push(row); row = [] }
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { pushField(); i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { pushRow(); i++; continue }
    field += ch; i++
  }
  // Trailing field/row (no final newline).
  if (field !== '' || row.length > 0) pushRow()
  // Drop rows that are entirely empty (blank lines).
  return rows.filter(r => r.some(f => f.trim() !== ''))
}

/**
 * Parse a length cell into milliseconds. Accepts `m:ss` (or `h:mm:ss`), plain
 * seconds (`372`), or milliseconds (values >= 30000 are treated as ms already).
 * Returns null for blank; throws on garbage.
 */
export function parseLengthMs(value: string): number | null {
  const v = value.trim()
  if (v === '') return null
  if (v.includes(':')) {
    const parts = v.split(':').map(p => Number.parseInt(p, 10))
    if (parts.some(Number.isNaN)) throw new Error(`invalid length: ${value}`)
    return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid length: ${value}`)
  // Heuristic: nobody's track is >= 30000 seconds, so large numbers are ms.
  return n >= 30_000 ? Math.round(n) : Math.round(n * 1000)
}

/** Normalize a raw header for matching/mapping: lowercase, spaces → underscores. */
export function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

export interface CsvPreview {
  /** Headers in file order: raw display text + the normalized mapping key. */
  headers: Array<{raw: string, key: string}>
  /** Up to the first 5 data rows, for the mapping dialog. */
  sampleRows: string[][]
  /** Auto-detected role → header-key mapping (nulls where nothing matched). */
  autoMapping: CsvMapping
}

/** Inspect a CSV for the import dialog: headers, sample rows, auto-mapping. */
export function previewCsv(text: string): CsvPreview | {error: string} {
  const rows = parseCsv(text)
  const header = rows[0]
  if (header === undefined) return {error: 'empty file'}
  const headers = header.map((h) => ({raw: h.trim(), key: headerKey(h)}))
  const keys = new Set(headers.map((h) => h.key))
  const auto = (name: string): string | null => (keys.has(name) ? name : null)
  return {
    headers,
    sampleRows: rows.slice(1, 6),
    autoMapping: {
      artist: auto('artist'),
      title: auto('title'),
      remix: auto('remix'),
      length: auto('length'),
      copyText: auto('copy_text'),
    },
  }
}

export interface ParseWantlistOpts {
  /** Explicit role → header-key mapping. Omit/null = auto-detect by header name. */
  mapping?: CsvMapping | null
  /** Cleaning rules applied to artist/title/remix/copy_text at import. */
  rules?: CleaningRule[]
}

/** Parse full CSV text into wantlist rows per the contract above. */
export function parseWantlistCsv(text: string, opts?: ParseWantlistOpts): CsvImportResult {
  const rows = parseCsv(text)
  const header = rows[0]
  if (header === undefined) return {rows: [], errors: ['empty file']}

  const col = new Map<string, number>()
  header.forEach((h, idx) => col.set(headerKey(h), idx))

  const mapping: CsvMapping = opts?.mapping ?? {
    artist: 'artist',
    title: 'title',
    remix: 'remix',
    length: 'length',
    copyText: 'copy_text',
  }
  const rules = opts?.rules ?? []

  const roleIdx = (role: keyof CsvMapping): number | undefined => {
    const key = mapping[role]
    return key === null ? undefined : col.get(key)
  }
  if (roleIdx('artist') === undefined || roleIdx('title') === undefined) {
    return {rows: [], errors: ['mapping must bind both "artist" and "title" to existing columns']}
  }

  const get = (r: string[], role: keyof CsvMapping): string => {
    const idx = roleIdx(role)
    return idx === undefined ? '' : (r[idx] ?? '').trim()
  }
  const cleaned = (value: string): string => (rules.length > 0 ? applyCleaningRules(value, rules) : value)

  const out: WantlistRow[] = []
  const errors: string[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (r === undefined) continue
    const line = i + 1
    const artist = cleaned(get(r, 'artist'))
    const title = cleaned(get(r, 'title'))
    if (artist === '') { errors.push(`line ${line}: artist is required`); continue }
    if (title === '') { errors.push(`line ${line}: title is required`); continue }
    let lengthMs: number | null = null
    try {
      lengthMs = parseLengthMs(get(r, 'length'))
    } catch {
      errors.push(`line ${line}: invalid length "${get(r, 'length')}"`)
      continue
    }
    const remix = cleaned(get(r, 'remix'))
    const copyText = cleaned(get(r, 'copyText'))
    out.push({
      artist,
      title,
      remix: remix === '' ? null : remix,
      lengthMs,
      copyText: copyText === '' ? null : copyText,
    })
  }
  return {rows: out, errors}
}
