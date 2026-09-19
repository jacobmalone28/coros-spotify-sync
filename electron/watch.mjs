import { execFile } from 'node:child_process'
import { readdir, statfs } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const watchLabel = /coros|\bpace\s*\d*\b/i
const windowsVolumes = `
$ErrorActionPreference = 'Stop'
@(Get-CimInstance Win32_LogicalDisk | Where-Object {
  ($_.DriveType -eq 2 -or $_.DriveType -eq 3) -and $_.DeviceID -ne $env:SystemDrive
} | Select-Object DeviceID, VolumeName) | ConvertTo-Json -Compress
`
const windowsEject = `
$ErrorActionPreference = 'Stop'
$drive = $env:COROS_EJECT_DRIVE
$shell = New-Object -ComObject Shell.Application
$item = $shell.Namespace(17).ParseName($drive)
if ($null -eq $item) { throw 'The watch volume is no longer available.' }
$item.InvokeVerb('Eject')
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if (-not (Test-Path -LiteralPath ($drive + '\\'))) { exit 0 }
  Start-Sleep -Milliseconds 250
}
throw 'Windows did not eject the watch. Close files using it or use Safely Remove Hardware.'
`

export function createWatchService({
  platform = process.platform,
  run = execute,
  listDirectories = readdir,
  getCapacity = statfs,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const normalize = (value) => {
    const resolved = paths.resolve(value)
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const command = (file, args, options = {}) => run(file, args, {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...options,
  })
  const powershell = (script, options) => command('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], options)

  async function mountedVolumes() {
    try {
      if (platform === 'darwin') {
        const entries = await listDirectories('/Volumes', { withFileTypes: true })
        return entries.filter((entry) => entry.isDirectory()).map((entry) => ({
          path: path.posix.join('/Volumes', entry.name), name: entry.name,
        }))
      }
      if (platform === 'win32') {
        const { stdout } = await powershell(windowsVolumes)
        const entries = JSON.parse(stdout.trim() || '[]')
        return (Array.isArray(entries) ? entries : [entries]).filter((entry) => /^[A-Z]:$/i.test(entry?.DeviceID)).map((entry) => ({
          path: `${entry.DeviceID}\\`, name: entry.VolumeName || entry.DeviceID,
        }))
      }
      if (platform === 'linux') {
        const { stdout } = await command('lsblk', ['--json', '--paths', '--output', 'NAME,LABEL,MOUNTPOINTS'])
        const volumes = []
        const visit = (devices, disk) => {
          for (const device of devices) {
            for (const mount of device.mountpoints ?? []) {
              if (typeof mount === 'string' && mount.startsWith('/') && mount !== '/') {
                volumes.push({ path: mount, name: device.label || path.posix.basename(mount), device: device.name, disk: disk ?? device.name })
              }
            }
            visit(device.children ?? [], disk ?? device.name)
          }
        }
        visit(JSON.parse(stdout).blockdevices)
        return volumes
      }
      throw new Error(`Unsupported platform: ${platform}`)
    } catch (error) {
      const hint = platform === 'linux' ? ' Install util-linux (lsblk) and mount the watch first.' : ''
      throw new Error(`Could not list mounted volumes.${hint} ${error.message}`)
    }
  }

  async function findWatch(configuredPath = '') {
    if (configuredPath && !paths.isAbsolute(configuredPath)) return null
    const volumes = await mountedVolumes()
    const candidates = configuredPath
      ? volumes.filter((volume) => normalize(volume.path) === normalize(configuredPath))
      : volumes.filter((volume) => watchLabel.test(volume.name))
    for (const volume of candidates) {
      try {
        const capacity = await getCapacity(volume.path)
        return {
          path: volume.path,
          name: volume.name,
          freeBytes: capacity.bavail * capacity.bsize,
          totalBytes: capacity.blocks * capacity.bsize,
        }
      } catch {
        continue
      }
    }
    return null
  }

  async function ejectWatch(configuredPath = '') {
    const watch = await findWatch(configuredPath)
    if (!watch) throw new Error('No mounted COROS watch found. Select the mounted volume root in Settings.')
    try {
      if (platform === 'darwin') {
        await command('diskutil', ['eject', watch.path])
      } else if (platform === 'win32') {
        await powershell(windowsEject, { env: { ...process.env, COROS_EJECT_DRIVE: watch.path.slice(0, 2) } })
      } else {
        const volume = (await mountedVolumes()).find((entry) => normalize(entry.path) === normalize(watch.path))
        if (!volume?.device?.startsWith('/dev/')) throw new Error('The watch is no longer mounted.')
        await command('udisksctl', ['unmount', '--block-device', volume.device, '--no-user-interaction'])
        if ((await mountedVolumes()).some((entry) => entry.disk === volume.disk)) {
          throw new Error('The watch still has mounted filesystems. Unmount them in your file manager before unplugging.')
        }
      }
      return { name: watch.name }
    } catch (error) {
      const hint = platform === 'linux' ? ' Install udisks2 and ensure your desktop session can unmount removable drives.' : ''
      throw new Error(`Could not eject ${watch.name}.${hint} ${error.stderr?.trim() || error.message}`)
    }
  }

  return { findWatch, ejectWatch }
}