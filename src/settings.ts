// User-configurable settings, persisted inside the JSON db.
//
// Sections are updated whole: the PUT endpoint accepts any subset of the
// top-level sections, but a section that is present must validate completely.

import * as z from 'zod'
import {TIERS, type RankerConfig} from '@cratepilot/soulseek-toolkit'

// --- cleaning rules ---

/**
 * One find/replace normalization rule, applied in list order to the artist /
 * title / remix / copy_text fields at CSV import time. `find` is a literal
 * string unless `regex` is set. Invalid user regexes are skipped at apply time.
 */
export const cleaningRuleSchema = z.object({
  find: z.string().min(1),
  replace: z.string().default(''),
  regex: z.boolean().default(false),
  caseInsensitive: z.boolean().default(true),
})
export type CleaningRule = z.infer<typeof cleaningRuleSchema>

const ESCAPE_REGEX = /[.*+?^${}()|[\]\\]/g

/** Apply the rules to one value, in order. Bad regexes are skipped, never thrown. */
export function applyCleaningRules(value: string, rules: CleaningRule[]): string {
  let out = value
  for (const rule of rules) {
    try {
      const source = rule.regex ? rule.find : rule.find.replace(ESCAPE_REGEX, '\\$&')
      const re = new RegExp(source, rule.caseInsensitive ? 'gi' : 'g')
      out = out.replace(re, rule.replace)
    } catch {
      // invalid user regex — skip this rule
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

// --- csv column mapping ---

/** Maps each import role to a CSV header (normalized lowercase), or null = unused. */
export const csvMappingSchema = z.object({
  artist: z.string().nullable(),
  title: z.string().nullable(),
  remix: z.string().nullable(),
  length: z.string().nullable(),
  copyText: z.string().nullable(),
})
export type CsvMapping = z.infer<typeof csvMappingSchema>

// --- sections ---

export const rankerSettingsSchema = z.object({
  enabledTiers: z.array(z.enum(TIERS)).min(1),
  mp3HighKbps: z.number().int().min(64).max(2000),
  mp3FloorKbps: z.number().int().min(64).max(2000),
  lengthToleranceMs: z.number().int().min(0).max(60_000),
}).refine((r) => r.mp3FloorKbps <= r.mp3HighKbps, {message: 'mp3FloorKbps must be <= mp3HighKbps'})

export const schedulerSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Re-search unresolved wantlist tracks no more often than this. */
  intervalHours: z.number().min(1).max(24 * 14),
})

export const soulseekSettingsSchema = z.object({
  // Stored in plain text in the local JSON db — same trust level as slskd's own
  // YAML config. Used by the desktop shell to configure the bundled slskd.
  username: z.string(),
  password: z.string(),
})

export interface Settings {
  ranker: z.infer<typeof rankerSettingsSchema>
  scheduler: z.infer<typeof schedulerSettingsSchema>
  cleaningRules: CleaningRule[]
  /** Last-used CSV mapping (pre-fills the import dialog). null = auto-detect. */
  csvMapping: CsvMapping | null
  soulseek: z.infer<typeof soulseekSettingsSchema>
}

export const DEFAULT_SETTINGS: Settings = {
  ranker: {
    enabledTiers: [...TIERS],
    mp3HighKbps: 320,
    mp3FloorKbps: 192,
    lengthToleranceMs: 2000,
  },
  scheduler: {enabled: false, intervalHours: 12},
  cleaningRules: [],
  csvMapping: null,
  soulseek: {username: '', password: ''},
}

/** PUT body: any subset of sections; present sections validate completely. */
export const updateSettingsSchema = z.object({
  ranker: rankerSettingsSchema.optional(),
  scheduler: schedulerSettingsSchema.optional(),
  cleaningRules: z.array(cleaningRuleSchema).optional(),
  csvMapping: csvMappingSchema.nullable().optional(),
  soulseek: soulseekSettingsSchema.optional(),
})

/** Merge a stored (possibly partial/stale) settings object over the defaults. */
export function withDefaults(stored: Partial<Settings> | undefined): Settings {
  return {
    ranker: stored?.ranker ?? DEFAULT_SETTINGS.ranker,
    scheduler: stored?.scheduler ?? DEFAULT_SETTINGS.scheduler,
    cleaningRules: stored?.cleaningRules ?? DEFAULT_SETTINGS.cleaningRules,
    csvMapping: stored?.csvMapping ?? DEFAULT_SETTINGS.csvMapping,
    soulseek: stored?.soulseek ?? DEFAULT_SETTINGS.soulseek,
  }
}

/** The toolkit RankerConfig for the current settings (drives the auto pipeline). */
export function toRankerConfig(settings: Settings): RankerConfig {
  return {
    enabledTiers: settings.ranker.enabledTiers,
    lengthToleranceMs: settings.ranker.lengthToleranceMs,
    mp3HighKbps: settings.ranker.mp3HighKbps,
    mp3FloorKbps: settings.ranker.mp3FloorKbps,
  }
}
