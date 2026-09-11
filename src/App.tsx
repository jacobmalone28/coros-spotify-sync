import { useEffect, useState } from 'react'
import { Cable, Check, ChevronRight, Download, Eject, FolderOpen, HardDrive, LoaderCircle, Music2, RefreshCw, Search, Settings, Watch as WatchIcon, Wifi } from 'lucide-react'
import type { Config, DownloadProgress, Playlist, Watch } from './types'
import './App.css'

const emptyConfig: Config = { spotifyClientId: '', downloadPath: '', watchPath: '' }

function formatBytes(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function App() {
  const [config, setConfig] = useState<Config>(emptyConfig)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selected, setSelected] = useState<Playlist | null>(null)
  const [watch, setWatch] = useState<Watch | null>(null)
  const [connected, setConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('Ready')
  const [busy, setBusy] = useState<'login' | 'download' | 'eject' | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const bridge = window.coros

  useEffect(() => {
    async function initialize() {
      if (!bridge) return
      try {
        const savedConfig = await bridge.getConfig()
        setConfig(savedConfig)
        if (!savedConfig.spotifyClientId) return
        setBusy('login')
        setStatus('Restoring Spotify session')
        if (await bridge.restoreSpotify(savedConfig.spotifyClientId)) {
          setPlaylists(await bridge.getPlaylists())
          setConnected(true)
          setStatus('Spotify connected')
        } else {
          setStatus('Connect Spotify to continue')
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(null)
      }
    }

    void initialize()
    bridge?.onDownloadProgress((progress) => {
      setDownloadProgress(progress)
      setStatus(progress.activeTracks.length > 1
        ? `Downloading ${progress.activeTracks.length} songs in parallel · ${progress.current} of ${progress.total} complete`
        : `${progress.message}: ${progress.trackName}`)
    })
  }, [bridge])

  async function login() {
    if (!bridge) return setStatus('Open the app with npm run desktop:dev')
    if (!config.spotifyClientId.trim()) {
      setSettingsOpen(true)
      setStatus('Add your Spotify client ID to connect')
      return
    }
    setBusy('login')
    try {
      await bridge.login(config.spotifyClientId)
      setPlaylists(await bridge.getPlaylists())
      setConnected(true)
      setStatus('Spotify connected')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function detectWatch() {
    if (!bridge) return
    const detected = await bridge.detectWatch(config.watchPath)
    setWatch(detected)
    setStatus(detected ? `${detected.name} is ready` : 'No mounted COROS volume found')
  }

  async function ejectWatch() {
    if (!bridge || !watch) return
    setBusy('eject')
    try {
      const result = await bridge.ejectWatch(config.watchPath)
      setWatch(null)
      setStatus(`${result.name} ejected safely`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function downloadPlaylist() {
    if (!bridge || !selected) return
    setBusy('download')
    setDownloadProgress({ current: 0, total: selected.tracks, trackName: selected.name, percent: 0, message: 'Reading playlist', activeTracks: [] })
    setStatus(`Preparing ${selected.name}`)
    try {
      const result = await bridge.download(selected, config)
      setStatus(result.failures.length
        ? `${result.transferred} of ${result.total} tracks written to Music; ${result.failures.length} unavailable`
        : `${result.transferred} tracks written to the watch Music folder`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function saveSettings() {
    if (!bridge) return
    await bridge.saveConfig(config)
    setSettingsOpen(false)
    setStatus('Settings saved')
  }

  async function chooseDirectory(field: 'downloadPath' | 'watchPath') {
    if (!bridge) return
    const chosen = await bridge.chooseDirectory(config[field])
    if (chosen) setConfig({ ...config, [field]: chosen })
  }

  const visible = playlists.filter((playlist) => playlist.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Music2 size={18} /></span><strong>COROS SYNC</strong></div>
        <div className="top-actions">
          <span className={`connection ${connected ? 'online' : ''}`}><span />{connected ? 'Spotify connected' : 'Spotify offline'}</span>
          <button className="icon-button" title="Settings" onClick={() => setSettingsOpen(true)}><Settings size={19} /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <p className="eyebrow">Transfer</p>
          <nav>
            <div className={`step ${connected ? 'complete' : 'active'}`}><span>{connected ? <Check size={14} /> : '1'}</span><div><strong>Spotify</strong><small>{connected ? 'Connected' : 'Choose music'}</small></div></div>
            <div className={`step ${connected && !watch ? 'active' : watch ? 'complete' : ''}`}><span>{watch ? <Check size={14} /> : '2'}</span><div><strong>COROS watch</strong><small>{watch ? watch.name : 'Connect by USB'}</small></div></div>
            <div className={`step ${watch ? 'active' : ''}`}><span>3</span><div><strong>Download</strong><small>Direct to watch</small></div></div>
          </nav>
          <div className="transport-note"><Cable size={19} /><div><strong>USB transfer</strong><p>Bluetooth music transfer is not exposed by COROS.</p></div></div>
        </aside>

        <section className="content">
          <div className="content-heading">
            <div><p className="eyebrow">Your library</p><h1>Choose a playlist</h1></div>
            {!connected && <button className="spotify-button" onClick={login} disabled={!!busy}>{busy === 'login' ? <LoaderCircle className="spin" size={18} /> : <Wifi size={18} />} Connect Spotify</button>}
          </div>

          <div className="search-row">
            <label className="search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search playlists" /></label>
            <button className="quiet-button" onClick={login} disabled={!connected || !!busy}><RefreshCw size={16} /> Refresh</button>
          </div>

          <div className="playlist-list">
            {!connected && <div className="empty-state"><div className="record"><Music2 size={30} /></div><h2>Your playlists will appear here</h2><p>Connect Spotify to select the music you want on your Pace 4.</p></div>}
            {visible.map((playlist) => (
              <button key={playlist.id} className={`playlist ${selected?.id === playlist.id ? 'selected' : ''}`} onClick={() => setSelected(playlist)}>
                {playlist.image ? <img src={playlist.image} alt="" /> : <span className="cover-fallback"><Music2 /></span>}
                <span className="playlist-copy"><strong>{playlist.name}</strong><small>{playlist.tracks} songs · {playlist.owner}{!playlist.isPublic && ' · Private'}</small></span>
                {selected?.id === playlist.id ? <span className="selected-check"><Check size={15} /></span> : <ChevronRight size={18} />}
              </button>
            ))}
          </div>
        </section>

        <aside className="device-panel">
          <div className="watch-visual"><WatchIcon size={74} strokeWidth={1.1} /><span>Pace 4</span></div>
          <h2>{watch ? watch.name : 'Connect your watch'}</h2>
          <p>{watch ? `${formatBytes(watch.freeBytes)} free of ${formatBytes(watch.totalBytes)}` : 'Attach the charging cable and mount the watch to continue.'}</p>
          <div className="device-actions">
            <button className="outline-button" onClick={detectWatch} disabled={!!busy}><HardDrive size={17} /> Detect</button>
            <button className="outline-button" onClick={ejectWatch} disabled={!watch || !!busy}>{busy === 'eject' ? <LoaderCircle className="spin" size={17} /> : <Eject size={17} />} Eject</button>
          </div>
          <div className="divider" />
          <div className="selection-summary"><small>Selected playlist</small><strong>{selected?.name ?? 'None selected'}</strong><span>{selected ? `${selected.tracks} songs` : 'Choose one from your library'}</span></div>
          <button className="primary-button" disabled={!selected || !watch || !!busy} onClick={downloadPlaylist}>{busy === 'download' ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />} Download to COROS</button>
          <p className="replace-warning">Replaces everything currently in the watch Music folder.</p>
          {downloadProgress && <div className="download-progress">
            <div className="progress-heading"><span>{downloadProgress.activeTracks.length > 1 ? `${downloadProgress.activeTracks.length} downloads active` : downloadProgress.message}</span><strong>{Math.round(downloadProgress.percent)}%</strong></div>
            <div className="progress"><span style={{ width: `${downloadProgress.percent}%` }} /></div>
            <small>{downloadProgress.current} of {downloadProgress.total} complete</small>
            {downloadProgress.activeTracks.length > 0 && <div className="active-downloads">
              {downloadProgress.activeTracks.map((track) => <div className="active-download" key={track.index}>
                <span className="active-track-name">{track.index}. {track.trackName}</span>
                <span className="active-track-state">{track.message} · {Math.round(track.percent)}%</span>
              </div>)}
            </div>}
          </div>}
        </aside>
      </div>

      <footer className="statusbar"><span className={busy ? 'pulse' : ''} />{status}</footer>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
        <section className="settings-panel" onMouseDown={(event) => event.stopPropagation()}>
          <div><p className="eyebrow">Local configuration</p><h2>Settings</h2></div>
          <label>Spotify client ID<input value={config.spotifyClientId} onChange={(event) => setConfig({ ...config, spotifyClientId: event.target.value })} /></label>
          <label>Download library<div className="path-input"><input value={config.downloadPath} onChange={(event) => setConfig({ ...config, downloadPath: event.target.value })} /><button title="Choose download folder" onClick={() => chooseDirectory('downloadPath')}><FolderOpen size={18} /></button></div></label>
          <label>Mounted watch path <small>Optional; auto-detected by name</small><div className="path-input"><input value={config.watchPath} onChange={(event) => setConfig({ ...config, watchPath: event.target.value })} /><button title="Choose watch volume" onClick={() => chooseDirectory('watchPath')}><FolderOpen size={18} /></button></div></label>
          <p className="redirect-note">Add <code>http://127.0.0.1:43821/callback</code> as a redirect URI in your Spotify developer app.</p>
          <div className="modal-actions"><button className="quiet-button" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary-button" onClick={saveSettings}>Save settings</button></div>
        </section>
      </div>}
    </main>
  )
}

export default App
