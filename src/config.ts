import * as z from 'zod'

/**
 * Enhancer env. slskd connection vars (`SLSKD_BASE_URL`/`SLSKD_API_KEY`) are
 * validated separately by the toolkit's `slskdEnvSchema` when the client is
 * created — this schema owns everything else.
 */
export const envSchema = z.object({
  /** HTTP bind. Loopback by default — this is a personal, unauthenticated app. */
  ENHANCER_HOST: z.string().default('127.0.0.1'),
  ENHANCER_PORT: z.coerce.number().int().min(1).max(65535).default(5271),
  /** Where the JSON store lives. */
  ENHANCER_DATA_DIR: z.string().default('./data'),
  /** Host-visible path of slskd's completed-downloads folder. */
  SLSK_DOWNLOADS_ROOT: z.string().default('./downloads'),
  // Orchestrator knobs (defaults mirror the toolkit's worker schema).
  SLSK_TRANSFER_POLL_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  SLSK_STALL_THRESHOLD_MS: z.coerce.number().int().min(5000).max(300_000).default(30_000),
  SLSK_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(5000).max(60_000).default(15_000),
  SLSK_SEARCH_POLL_MS: z.coerce.number().int().min(500).max(10_000).default(2000),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(): Env {
  return envSchema.parse(process.env)
}
