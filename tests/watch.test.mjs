import assert from 'node:assert/strict'
import test from 'node:test'
import { createWatchService } from '../electron/watch.mjs'

const capacity = { bavail: 10, bsize: 4096, blocks: 20 }
const getCapacity = async () => capacity
const directory = (name) => ({ name, isDirectory: () => true })
const linuxVolumes = (mountpoints = ['/run/media/user/COROS']) => ({
  stdout: JSON.stringify({ blockdevices: [
    { name: '/dev/sda', mountpoints: [null], children: [
      { name: '/dev/sda1', label: 'COROS', mountpoints },
    ] },
    { name: '/dev/nvme0n1p1', label: 'System', mountpoints: ['/'] },
  ] }),
})

test('macOS detects watch volumes and calculates capacity', async () => {
  const service = createWatchService({ platform: 'darwin', getCapacity,
    listDirectories: async () => [directory('Backup'), directory('PACE 4')],
  })
  assert.deepEqual(await service.findWatch(), {
    path: '/Volumes/PACE 4', name: 'PACE 4', freeBytes: 40960, totalBytes: 81920,
  })
  assert.equal(await service.findWatch('/tmp/arbitrary'), null)
  assert.equal(await service.findWatch('/Volumes/PACE 4/Music'), null)
})

test('configured volume supports custom labels but never falls back to another watch', async () => {
  const service = createWatchService({ platform: 'darwin', getCapacity,
    listDirectories: async () => [directory('Training'), directory('COROS')],
  })
  assert.equal((await service.findWatch('/Volumes/Training/')).name, 'Training')
  assert.equal(await service.findWatch('/Volumes/Disconnected'), null)
})

test('macOS ejection passes the volume path as one argument', async () => {
  const calls = []
  const service = createWatchService({ platform: 'darwin', getCapacity,
    listDirectories: async () => [directory('PACE 4')],
    run: async (...args) => { calls.push(args); return { stdout: '' } },
  })
  assert.deepEqual(await service.ejectWatch(), { name: 'PACE 4' })
  assert.deepEqual(calls[0].slice(0, 2), ['diskutil', ['eject', '/Volumes/PACE 4']])
})

test('Windows parses a single CIM result, normalizes drive roots, and confirms Shell ejection', async () => {
  const calls = []
  const service = createWatchService({ platform: 'win32', getCapacity,
    run: async (...args) => {
      calls.push(args)
      return { stdout: JSON.stringify({ DeviceID: 'E:', VolumeName: 'COROS' }) }
    },
  })
  assert.equal((await service.findWatch('e:\\')).path, 'E:\\')
  assert.equal(await service.findWatch('E:'), null)
  assert.equal(await service.findWatch('E:\\Music'), null)
  assert.deepEqual(await service.ejectWatch('E:\\'), { name: 'COROS' })
  const [file, args, options] = calls.at(-1)
  assert.equal(file, 'powershell.exe')
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /InvokeVerb\('Eject'\)/)
  assert.match(script, /Test-Path -LiteralPath/)
  assert.match(script, /throw 'Windows did not eject/)
  assert.equal(options.env.COROS_EJECT_DRIVE, 'E:')
  assert.equal(options.windowsHide, true)
})

test('Windows handles empty and multiple volumes', async () => {
  for (const stdout of ['', '[]', 'null']) {
    const service = createWatchService({ platform: 'win32', getCapacity, run: async () => ({ stdout }) })
    assert.equal(await service.findWatch(), null)
  }
  const service = createWatchService({ platform: 'win32', getCapacity,
    run: async () => ({ stdout: JSON.stringify([
      { DeviceID: 'D:', VolumeName: 'Backup' }, { DeviceID: 'F:', VolumeName: 'PACE 3' },
    ]) }),
  })
  assert.equal((await service.findWatch()).path, 'F:\\')
})

test('Linux traverses block devices and detects custom mount locations', async () => {
  const service = createWatchService({ platform: 'linux', getCapacity, run: async () => linuxVolumes(['/mnt/my-watch']) })
  assert.equal((await service.findWatch()).path, '/mnt/my-watch')
  assert.equal(await service.findWatch('/'), null)
  assert.equal(await service.findWatch('/mnt/my-watch/Music'), null)
})

test('Linux unmounts the discovered block device without shell interpolation', async () => {
  const calls = []
  let unmounted = false
  const service = createWatchService({ platform: 'linux', getCapacity,
    run: async (file, args) => {
      calls.push([file, args])
      if (file === 'udisksctl') unmounted = true
      return linuxVolumes(unmounted ? [] : ['/media/user/PACE 4'])
    },
  })
  assert.deepEqual(await service.ejectWatch(), { name: 'COROS' })
  assert.deepEqual(calls.find(([file]) => file === 'udisksctl'), [
    'udisksctl', ['unmount', '--block-device', '/dev/sda1', '--no-user-interaction'],
  ])
})

test('Linux never reports ejection success if the partition remains mounted', async () => {
  const service = createWatchService({ platform: 'linux', getCapacity, run: async () => linuxVolumes() })
  await assert.rejects(service.ejectWatch(), /still has mounted filesystems/)
})

test('Linux refuses safe-to-unplug success while a sibling partition is mounted', async () => {
  let unmounted = false
  const service = createWatchService({ platform: 'linux', getCapacity,
    run: async (file) => {
      if (file === 'udisksctl') unmounted = true
      const result = JSON.parse(linuxVolumes(unmounted ? [] : ['/media/COROS']).stdout)
      result.blockdevices[0].children.push({ name: '/dev/sda2', label: 'Other', mountpoints: ['/media/Other'] })
      return { stdout: JSON.stringify(result) }
    },
  })
  await assert.rejects(service.ejectWatch(), /still has mounted filesystems/)
})

test('unavailable volumes return null; discovery and ejection failures remain actionable', async () => {
  const unavailable = createWatchService({ platform: 'darwin',
    listDirectories: async () => [directory('COROS')],
    getCapacity: async () => { throw new Error('unplugged') },
  })
  assert.equal(await unavailable.findWatch(), null)
  await assert.rejects(unavailable.ejectWatch(), /No mounted COROS/)
  const missingTool = createWatchService({ platform: 'linux', run: async () => { throw new Error('ENOENT') } })
  await assert.rejects(missingTool.findWatch(), /Install util-linux/)
  const malformed = createWatchService({ platform: 'linux', run: async () => ({ stdout: 'invalid' }) })
  await assert.rejects(malformed.findWatch(), /Could not list mounted volumes/)
  const busy = createWatchService({ platform: 'linux', getCapacity,
    run: async (file) => {
      if (file === 'udisksctl') throw Object.assign(new Error('failed'), { stderr: 'Device busy' })
      return linuxVolumes()
    },
  })
  await assert.rejects(busy.ejectWatch(), /udisks2.*Device busy/)
})