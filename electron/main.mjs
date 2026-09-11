import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { access, cp, mkdir, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const CALLBACK_PORT = 43821
const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`
const DOWNLOAD_CONCURRENCY = 3
let mainWindow
let accessToken = ''

app.setPath('userData', path.join(app.getPath('appData'), 'coros-spotify-sync'))

const runtimePath = [
  path.join(app.getPath('home'), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  process.env.PATH,
].filter(Boolean).join(path.delimiter)

const configPath = () => path.join(app.getPath('userData'), 'config.json')
const authPath = () => path.join(app.getPath('userData'), 'spotify-auth.json')
const defaultConfig = () => ({
  spotifyClientId: '',
  downloadPath: path.join(app.getPath('music'), 'Coros Sync'),
  watchPath: '',
})

async function loadConfig() {
  try {
    const saved = JSON.parse(await readFile(configPath(), 'utf8'))
    const config = {
      spotifyClientId: saved.spotifyClientId ?? '',
      downloadPath: saved.downloadPath ?? defaultConfig().downloadPath,
      watchPath: saved.watchPath ?? '',
    }
    if (Object.hasOwn(saved, 'spotifyClientSecret')) await saveConfig(config)
    return config
  } catch {
    return defaultConfig()
  }
}

async function saveConfig(config) {
  await mkdir(path.dirname(configPath()), { recursive: true })
  await writeFile(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  return config
}

async function saveRefreshToken(refreshToken) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS secure credential storage is unavailable.')
  const encrypted = safeStorage.encryptString(refreshToken).toString('base64')
  await mkdir(path.dirname(authPath()), { recursive: true })
  await writeFile(authPath(), JSON.stringify({ refreshToken: encrypted }), { mode: 0o600 })
}

async function loadRefreshToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const saved = JSON.parse(await readFile(authPath(), 'utf8'))
    return safeStorage.decryptString(Buffer.from(saved.refreshToken, 'base64'))
  } catch {
    return null
  }
}

async function refreshSpotifyToken(clientId) {
  const refreshToken = await loadRefreshToken()
  if (!clientId || !refreshToken) return false
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  if (!response.ok) {
    if (response.status === 400) await rm(authPath(), { force: true })
    return false
  }
  const tokens = await response.json()
  accessToken = tokens.access_token
  if (tokens.refresh_token) await saveRefreshToken(tokens.refresh_token)
  return true
}

function base64Url(buffer) {
  return buffer.toString('base64url')
}

async function spotifyLogin(clientId) {
  if (!clientId) throw new Error('Add your Spotify client ID in Settings first.')
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(18))
  const authorize = new URL('https://accounts.spotify.com/authorize')
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: CALLBACK_URL,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: 'playlist-read-private playlist-read-collaborative',
  }).toString()

  const code = await new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? '/', CALLBACK_URL)
      if (callback.pathname !== '/callback') return
      const error = callback.searchParams.get('error')
      const returnedState = callback.searchParams.get('state')
      const returnedCode = callback.searchParams.get('code')
      response.writeHead(error || returnedState !== state ? 400 : 200, { 'Content-Type': 'text/html' })
      response.end('<body style="font:16px system-ui;padding:3rem">You can close this window and return to COROS Sync.</body>')
      server.close()
      if (error) reject(new Error(`Spotify authorization failed: ${error}`))
      else if (returnedState !== state || !returnedCode) reject(new Error('Spotify returned an invalid authorization response.'))
      else resolve(returnedCode)
    })
    server.on('error', reject)
    server.listen(CALLBACK_PORT, '127.0.0.1', () => shell.openExternal(authorize.toString()))
    setTimeout(() => {
      server.close()
      reject(new Error('Spotify login timed out.'))
    }, 180_000)
  })

  const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK_URL,
      code_verifier: verifier,
    }),
  })
  if (!tokenResponse.ok) throw new Error(`Spotify token request failed (${tokenResponse.status}).`)
  const tokens = await tokenResponse.json()
  accessToken = tokens.access_token
  if (tokens.refresh_token) await saveRefreshToken(tokens.refresh_token)
  return true
}

async function spotifyGet(url, allowRefresh = true) {
  if (!accessToken) throw new Error('Connect Spotify first.')
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (response.status === 401 && allowRefresh) {
    accessToken = ''
    const config = await loadConfig()
    if (await refreshSpotifyToken(config.spotifyClientId)) return spotifyGet(url, false)
  }
  if (response.status === 401) accessToken = ''
  if (!response.ok) throw new Error(`Spotify request failed (${response.status}).`)
  return response.json()
}

async function getPlaylists() {
  const playlists = []
  let next = 'https://api.spotify.com/v1/me/playlists?limit=50'
  while (next) {
    const page = await spotifyGet(next)
    playlists.push(...page.items.map((item) => ({
      id: item.id,
      name: item.name,
      image: item.images?.[0]?.url ?? '',
      tracks: item.items?.total ?? item.tracks?.total ?? 0,
      owner: item.owner.display_name,
      isPublic: item.public,
      url: item.external_urls.spotify,
    })))
    next = page.next
  }
  return playlists
}

function safeDirectoryName(name) {
  return name.replaceAll(/[/:]/g, '-').trim() || 'Playlist'
}

async function getPlaylistTracks(playlistId) {
  const tracks = []
  let next = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50`
  while (next) {
    const page = await spotifyGet(next)
    for (const entry of page.items) {
      const item = entry.item ?? entry.track
      if (item?.type === 'track' && item.external_urls?.spotify) {
        tracks.push({
          name: item.name,
          artist: item.artists?.map((artist) => artist.name).join(', ') ?? 'Unknown Artist',
        })
      }
    }
    next = page.next
  }
  return tracks
}

function outputFileName(track, index) {
  const safePart = (value) => safeDirectoryName(value).slice(0, 100)
  return `${String(index).padStart(3, '0')} - ${safePart(track.artist)} - ${safePart(track.name)}.mp3`
}

function runYtDlp(query, outputPath, track, attempt, reportProgress) {
  return new Promise((resolve, reject) => {
    reportProgress(0, attempt > 1 ? `Trying another source (${attempt}/3)` : 'Finding a matching track')
    const child = spawn('yt-dlp', [
      `ytsearch1:${query}`,
      '--no-playlist',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-metadata',
      '--embed-thumbnail',
      '--convert-thumbnails', 'jpg',
      '--newline',
      '--socket-timeout', '30',
      '--retries', '3',
      '--fragment-retries', '3',
      '--output', outputPath.replaceAll('%', '%%').replace(/\.mp3$/, '.%(ext)s'),
    ], { env: { ...process.env, PATH: runtimePath } })
    let output = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 300_000)
    const emit = (chunk) => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-4000)
      const match = text.match(/\[download\]\s+([\d.]+)%/)
      if (match) reportProgress(Number(match[1]), 'Downloading')
    }
    child.stdout.on('data', emit)
    child.stderr.on('data', emit)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(new Error(error.code === 'ENOENT' ? 'yt-dlp is not installed. Run: pipx install yt-dlp' : error.message))
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) return resolve(true)
      if (timedOut) return reject(new Error(`Download timed out for "${track.name}".`))
      const detail = output.replaceAll(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' ')
      reject(new Error(detail || `yt-dlp exited with code ${code}.`))
    })
  })
}

async function runDownloaderTrack(track, outputPath, reportProgress) {
  const queries = [
    `${track.artist} - ${track.name} official audio`,
    `${track.artist} - ${track.name} audio`,
    `${track.artist} - ${track.name} lyrics`,
  ]
  let lastError
  for (let attempt = 0; attempt < queries.length; attempt += 1) {
    try {
      await runYtDlp(queries[attempt], outputPath, track, attempt + 1, reportProgress)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function runDownload(playlist, config) {
  const watch = await findWatch(config.watchPath)
  if (!watch) throw new Error('Connect and detect your COROS watch before downloading.')
  const playlistName = safeDirectoryName(playlist.name)
  const cache = path.join(config.downloadPath, playlistName)
  const tracks = await getPlaylistTracks(playlist.id)
  if (tracks.length === 0) throw new Error(`Spotify returned no downloadable tracks for "${playlist.name}".`)
  const destination = path.join(watch.path, 'Music')
  await mkdir(destination, { recursive: true })
  mainWindow?.webContents.send('download:progress', { current: 0, total: tracks.length, trackName: playlist.name, percent: 0, message: 'Clearing watch music', activeTracks: [] })
  for (const entry of await readdir(destination)) {
    await rm(path.join(destination, entry), { recursive: true, force: true })
  }
  const failures = []
  let transferred = 0
  let nextIndex = 0
  let completed = 0
  const activeProgress = new Map()
  const reportProgress = (index, trackName, percent, message) => {
    activeProgress.set(index, { trackName, percent, message })
    const aggregate = completed + [...activeProgress.values()].reduce((sum, progress) => sum + progress.percent / 100, 0)
    mainWindow?.webContents.send('download:progress', {
      current: completed,
      total: tracks.length,
      trackName,
      percent: aggregate / tracks.length * 100,
      message,
      activeTracks: [...activeProgress.entries()]
        .sort(([left], [right]) => left - right)
        .map(([trackIndex, progress]) => ({ index: trackIndex + 1, ...progress })),
    })
  }
  const worker = async () => {
    while (nextIndex < tracks.length) {
      const index = nextIndex
      nextIndex += 1
      const track = tracks[index]
      const fileName = outputFileName(track, index + 1)
      const outputPath = path.join(destination, fileName)
      const cachedPath = path.join(cache, fileName)
      try {
        if (await stat(cachedPath).then(() => true, () => false)) {
          await cp(cachedPath, outputPath)
          reportProgress(index, track.name, 100, 'Copied from local cache')
        } else {
          await runDownloaderTrack(track, outputPath, (percent, message) => reportProgress(index, track.name, percent, message))
        }
        transferred += 1
      } catch (error) {
        failures.push(`${track.artist} - ${track.name}: ${error instanceof Error ? error.message : String(error)}`)
        reportProgress(index, track.name, 100, 'Skipped after 3 failed sources')
      }
      activeProgress.delete(index)
      completed += 1
      const aggregate = completed + [...activeProgress.values()].reduce((sum, progress) => sum + progress.percent / 100, 0)
      mainWindow?.webContents.send('download:progress', {
        current: completed,
        total: tracks.length,
        trackName: track.name,
        percent: aggregate / tracks.length * 100,
        message: completed === tracks.length ? 'Download complete' : 'Starting next track',
        activeTracks: [...activeProgress.entries()]
          .sort(([left], [right]) => left - right)
          .map(([trackIndex, progress]) => ({ index: trackIndex + 1, ...progress })),
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tracks.length) }, worker))
  return { transferred, total: tracks.length, failures, destination }
}

function ejectWatch(configuredPath = '') {
  return findWatch(configuredPath).then((watch) => {
    if (!watch) throw new Error('No mounted COROS watch found.')
    return new Promise((resolve, reject) => {
      const child = spawn('diskutil', ['eject', watch.path])
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { output += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve({ name: watch.name })
        else reject(new Error(output.trim() || `Could not eject ${watch.name}.`))
      })
    })
  })
}

async function findWatch(configuredPath = '') {
  const mountedCandidates = (await readdir('/Volumes', { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /coros|pace\s*\d*/i.test(entry.name))
    .map((entry) => path.join('/Volumes', entry.name))
  const candidates = [...new Set([configuredPath, ...mountedCandidates].filter(Boolean))]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      const capacity = await statfs(candidate)
      return { path: candidate, name: path.basename(candidate), freeBytes: capacity.bavail * capacity.bsize, totalBytes: capacity.blocks * capacity.bsize }
    } catch {
      // Try the next mounted volume.
    }
  }
  return null
}

function registerIpc() {
  ipcMain.handle('config:get', loadConfig)
  ipcMain.handle('config:save', (_event, config) => saveConfig(config))
  ipcMain.handle('directory:choose', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog({ defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('spotify:login', (_event, clientId) => spotifyLogin(clientId))
  ipcMain.handle('spotify:restore', (_event, clientId) => refreshSpotifyToken(clientId))
  ipcMain.handle('spotify:playlists', getPlaylists)
  ipcMain.handle('download:start', (_event, playlist, config) => runDownload(playlist, config))
  ipcMain.handle('watch:detect', (_event, configuredPath) => findWatch(configuredPath))
  ipcMain.handle('watch:eject', (_event, configuredPath) => ejectWatch(configuredPath))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#f3f1eb',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs') },
  })
  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else mainWindow.loadFile(path.join(import.meta.dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
})
app.on('window-all-closed', () => app.quit())