export type Config = {
  spotifyClientId: string
  downloadPath: string
  watchPath: string
}

export type Playlist = {
  id: string
  name: string
  image: string
  tracks: number
  owner: string
  isPublic: boolean
  url: string
}

export type Watch = {
  path: string
  name: string
  freeBytes: number
  totalBytes: number
}

export type DownloadProgress = {
  current: number
  total: number
  trackName: string
  percent: number
  message: string
  activeTracks: Array<{
    index: number
    trackName: string
    percent: number
    message: string
  }>
}

export type DownloadResult = {
  transferred: number
  total: number
  failures: string[]
  destination: string
}

declare global {
  interface Window {
    coros?: {
      getConfig(): Promise<Config>
      saveConfig(config: Config): Promise<Config>
      chooseDirectory(defaultPath: string): Promise<string | null>
      login(clientId: string): Promise<boolean>
      restoreSpotify(clientId: string): Promise<boolean>
      getPlaylists(): Promise<Playlist[]>
      download(playlist: Playlist, config: Config): Promise<DownloadResult>
      detectWatch(configuredPath: string): Promise<Watch | null>
      ejectWatch(configuredPath: string): Promise<{ name: string }>
      onDownloadProgress(callback: (progress: DownloadProgress) => void): void
    }
  }
}