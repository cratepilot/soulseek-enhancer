import type {JSX} from 'react'
import {useState} from 'react'
import {SearchTab} from './SearchTab.js'
import {WantlistTab} from './WantlistTab.js'
import {DownloadsTab} from './DownloadsTab.js'
import {BlacklistTab} from './BlacklistTab.js'
import {SettingsTab} from './SettingsTab.js'
import {useIgnoredPeers} from './use-ignored-peers.js'

const TABS = ['Search', 'Wantlist', 'Downloads', 'Blacklist', 'Settings'] as const
type Tab = typeof TABS[number]

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('Search')
  // Single blacklist instance shared by all tabs: candidates hide instantly and
  // the count badge stays in sync when a peer is blocked from the search view.
  const ignored = useIgnoredPeers()

  return (
    <div className="app">
      <header>
        <h1>Soulseek Enhancer</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t}
              className={t === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(t)}
            >
              {t}
              {t === 'Blacklist' && ignored.peers.length > 0 ? ` (${ignored.peers.length})` : ''}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'Search' && <SearchTab ignored={ignored} />}
        {tab === 'Wantlist' && <WantlistTab />}
        {tab === 'Downloads' && <DownloadsTab />}
        {tab === 'Blacklist' && <BlacklistTab ignored={ignored} />}
        {tab === 'Settings' && <SettingsTab />}
      </main>
    </div>
  )
}
