import type {JSX} from 'react'
import {useEffect, useState} from 'react'
import {getSettings, putSettings, type CleaningRule, type Settings, type Tier} from './api.js'

const ALL_TIERS: Array<{tier: Tier, label: string}> = [
  {tier: 'flac', label: 'FLAC'},
  {tier: 'wav', label: 'WAV'},
  {tier: 'aiff', label: 'AIFF'},
  {tier: 'mp3-320-plus', label: 'MP3 (high bitrate)'},
  {tier: 'mp3-192-plus', label: 'MP3 (acceptable bitrate)'},
]

/**
 * Settings: format/quality preferences (drives the auto pipeline's ranker),
 * the re-search scheduler, data-cleaning rules, and the Soulseek login used
 * by the bundled slskd in the desktop app.
 */
export function SettingsTab(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getSettings().then(setSettings).catch((e: unknown) => setError(e instanceof Error ? e.message : 'failed to load settings'))
  }, [])

  if (settings === null) return <p className="muted">{error ?? 'Loading…'}</p>

  const update = (patch: Partial<Settings>): void => setSettings({...settings, ...patch})

  const toggleTier = (tier: Tier): void => {
    const has = settings.ranker.enabledTiers.includes(tier)
    const enabledTiers = has
      ? settings.ranker.enabledTiers.filter((t) => t !== tier)
      : [...settings.ranker.enabledTiers, tier]
    if (enabledTiers.length === 0) return // at least one tier must stay on
    update({ranker: {...settings.ranker, enabledTiers}})
  }

  const updateRule = (idx: number, patch: Partial<CleaningRule>): void => {
    const cleaningRules = settings.cleaningRules.map((r, i) => (i === idx ? {...r, ...patch} : r))
    update({cleaningRules})
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      const res = await putSettings({
        ranker: settings.ranker,
        scheduler: settings.scheduler,
        cleaningRules: settings.cleaningRules.filter((r) => r.find.trim() !== ''),
        soulseek: settings.soulseek,
      })
      setMessage(res.slskdRestartRequired
        ? 'Saved. Restart the app for the new Soulseek login to take effect.'
        : 'Saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings">
      <h2>Formats &amp; quality</h2>
      <p className="muted">Which formats the auto-download pipeline accepts, best-first: FLAC → WAV → AIFF → MP3.</p>
      {ALL_TIERS.map(({tier, label}) => (
        <label key={tier} className="row">
          <input
            type="checkbox"
            checked={settings.ranker.enabledTiers.includes(tier)}
            onChange={() => toggleTier(tier)}
          />
          {label}
        </label>
      ))}
      <label className="row">MP3 high-bitrate threshold (kbps)
        <input type="number" value={settings.ranker.mp3HighKbps}
          onChange={(e) => update({ranker: {...settings.ranker, mp3HighKbps: Number(e.target.value)}})} />
      </label>
      <label className="row">MP3 minimum bitrate (kbps, below = rejected)
        <input type="number" value={settings.ranker.mp3FloorKbps}
          onChange={(e) => update({ranker: {...settings.ranker, mp3FloorKbps: Number(e.target.value)}})} />
      </label>
      <label className="row">Track-length tolerance (± ms)
        <input type="number" value={settings.ranker.lengthToleranceMs}
          onChange={(e) => update({ranker: {...settings.ranker, lengthToleranceMs: Number(e.target.value)}})} />
      </label>

      <h2>Scheduler</h2>
      <label className="row">
        <input
          type="checkbox"
          checked={settings.scheduler.enabled}
          onChange={(e) => update({scheduler: {...settings.scheduler, enabled: e.target.checked}})}
        />
        Automatically re-search unresolved wantlist tracks
      </label>
      <label className="row">Minimum hours between searches of the same track
        <input type="number" min={1} value={settings.scheduler.intervalHours}
          disabled={!settings.scheduler.enabled}
          onChange={(e) => update({scheduler: {...settings.scheduler, intervalHours: Number(e.target.value)}})} />
      </label>

      <h2>Data cleaning rules</h2>
      <p className="muted">
        Find/replace applied (in order) to artist/title/remix/copy_text when importing a CSV —
        e.g. strip <code>(Original Mix)</code> or label suffixes. Regex optional.
      </p>
      {settings.cleaningRules.map((rule, idx) => (
        <div className="row rule" key={idx}>
          <input placeholder="find…" value={rule.find} onChange={(e) => updateRule(idx, {find: e.target.value})} />
          <span className="muted">→</span>
          <input placeholder="replace with (empty = remove)" value={rule.replace} onChange={(e) => updateRule(idx, {replace: e.target.value})} />
          <label className="row"><input type="checkbox" checked={rule.regex} onChange={(e) => updateRule(idx, {regex: e.target.checked})} />regex</label>
          <label className="row"><input type="checkbox" checked={rule.caseInsensitive} onChange={(e) => updateRule(idx, {caseInsensitive: e.target.checked})} />ignore case</label>
          <button className="ghost" onClick={() => update({cleaningRules: settings.cleaningRules.filter((_, i) => i !== idx)})}>✕</button>
        </div>
      ))}
      <button className="ghost" onClick={() => update({cleaningRules: [...settings.cleaningRules, {find: '', replace: '', regex: false, caseInsensitive: true}]})}>
        + Add rule
      </button>

      <h2>Soulseek login</h2>
      <p className="muted">Used by the bundled slskd (desktop app). Stored locally in plain text — same as slskd's own config.</p>
      <label className="row">Username
        <input value={settings.soulseek.username}
          onChange={(e) => update({soulseek: {...settings.soulseek, username: e.target.value}})} />
      </label>
      <label className="row">Password
        <input type="password" value={settings.soulseek.password}
          onChange={(e) => update({soulseek: {...settings.soulseek, password: e.target.value}})} />
      </label>

      <div className="row save-row">
        <button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
        {message && <span className="muted">{message}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </section>
  )
}
