/**
 * Unit tests for src/inspect.ts.
 *
 * The exec wrapper is mocked so no real libguestfs runs; guestfish output comes
 * from __fixtures__/samples. The guestmount mock writes a real /etc/os-release
 * into the real temp mount directory so os-release parsing is exercised against
 * actual bytes on disk. node:fs is NOT mocked.
 */
import { jest } from '@jest/globals'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'
import { exec } from '../__fixtures__/exec.js'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/exec.js', () => ({ exec }))

const { inspectFilesystem } = await import('../src/inspect.js')
const { CleanupRegistry } = await import('../src/cleanup.js')

const sample = (name: string): string =>
  readFileSync(join('__fixtures__/samples', name), 'utf8')

const ROOTS = sample('guestfish-inspect-os.txt')
const ARCH = sample('guestfish-inspect-arch.txt')
const APPS = sample('guestfish-list-applications2.txt')
const OS_RELEASE = sample('os-release')

const DISK = '/tmp/disk.qcow2'

interface ExecStubs {
  roots?: string
  arch?: string
  apps?: string
  writeOsRelease?: boolean
  osRelease?: string
  guestunmountExit?: number
}

function installExec(stubs: ExecStubs = {}): void {
  const roots = stubs.roots ?? ROOTS
  const arch = stubs.arch ?? ARCH
  const apps = stubs.apps ?? APPS
  const writeOsRelease = stubs.writeOsRelease ?? true
  const osRelease = stubs.osRelease ?? OS_RELEASE
  const guestunmountExit = stubs.guestunmountExit ?? 0

  exec.mockImplementation(async (cmd, args = []) => {
    if (cmd === 'guestfish') {
      if (args.includes('inspect-get-arch')) {
        return { stdout: arch, stderr: '', exitCode: 0 }
      }
      if (args.includes('inspect-list-applications2')) {
        // inspect-list-applications2 reads guest files and requires the root
        // filesystem to be mounted in the same session. Real guestfish (and
        // therefore the throw-on-non-zero exec wrapper) fails hard when the
        // mount step is missing; mirror that here so a regression that drops the
        // mount is caught.
        if (!args.includes('mount')) {
          throw new Error(
            'libguestfs: error: filesize: filesize_stub: you must call ' +
              "'mount' first to mount the root filesystem"
          )
        }
        return { stdout: apps, stderr: '', exitCode: 0 }
      }
      return { stdout: roots, stderr: '', exitCode: 0 }
    }
    if (cmd === 'guestmount') {
      const mountPath = args[args.length - 1]
      if (writeOsRelease) {
        mkdirSync(join(mountPath, 'etc'), { recursive: true })
        writeFileSync(join(mountPath, 'etc', 'os-release'), osRelease)
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    // guestunmount
    return { stdout: '', stderr: '', exitCode: guestunmountExit }
  })
}

describe('inspect.ts', () => {
  let registry: InstanceType<typeof CleanupRegistry>

  beforeEach(() => {
    registry = new CleanupRegistry()
  })

  afterEach(async () => {
    await registry.drain()
    jest.resetAllMocks()
  })

  it('parses the full filesystem view and registers exactly one teardown', async () => {
    installExec()
    const addSpy = jest.spyOn(registry, 'add')

    const view = await inspectFilesystem(DISK, registry)

    expect(view.operatingSystem).toEqual({
      id: 'ubuntu',
      versionId: '24.04',
      prettyName: 'Ubuntu 24.04.1 LTS',
      arch: 'x86_64'
    })
    expect(view.packages).toEqual([
      { name: 'base-files', version: '13ubuntu10.2' },
      { name: 'bash', version: '5.2.21-2ubuntu4' },
      { name: 'coreutils', version: '9.4-3ubuntu6' },
      { name: 'openssl', version: '3.0.13-0ubuntu3.1' }
    ])
    expect(view.mountPath).toMatch(/attest-mount-/)
    // Exactly one mount teardown pair registered for the run.
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('mounts the root filesystem before enumerating applications', async () => {
    installExec()

    await inspectFilesystem(DISK, registry)

    const appsCall = exec.mock.calls.find(
      (call) =>
        call[0] === 'guestfish' &&
        (call[1] as string[]).includes('inspect-list-applications2')
    )
    expect(appsCall).toBeDefined()
    const appArgs = appsCall![1] as string[]
    // The root fs is mounted at "/" in the same session, before the listing.
    expect(appArgs).toEqual(expect.arrayContaining(['mount', '/dev/sda1', '/']))
    expect(appArgs.indexOf('mount')).toBeLessThan(
      appArgs.indexOf('inspect-list-applications2')
    )
  })

  it('mounts read-only with the direct libguestfs backend', async () => {
    installExec()

    await inspectFilesystem(DISK, registry)

    expect(exec).toHaveBeenCalledWith(
      'guestmount',
      expect.arrayContaining(['--ro', '-a', DISK, '-i']),
      expect.objectContaining({
        env: expect.objectContaining({ LIBGUESTFS_BACKEND: 'direct' })
      })
    )
  })

  it('drains the teardown by unmounting with the direct backend', async () => {
    installExec()

    await inspectFilesystem(DISK, registry)
    await registry.drain()

    expect(exec).toHaveBeenCalledWith(
      'guestunmount',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ LIBGUESTFS_BACKEND: 'direct' }),
        ignoreReturnCode: true
      })
    )
  })

  it('retries guestunmount once when the first attempt fails', async () => {
    installExec({ guestunmountExit: 1 })

    await inspectFilesystem(DISK, registry)
    await registry.drain()

    const unmountCalls = exec.mock.calls.filter(
      (call) => call[0] === 'guestunmount'
    )
    expect(unmountCalls.length).toBe(2)
  })

  it('parses os-release edge cases: comments, blanks, quotes, missing fields', async () => {
    // Comment and blank lines are skipped, a line without "=" is ignored, a
    // single-quoted value is unquoted, and absent ID/VERSION_ID/PRETTY_NAME
    // default to empty strings.
    installExec({
      osRelease: "# a comment\n\nNAME='Debian'\nNOTAKEYVALUE\n"
    })

    const view = await inspectFilesystem(DISK, registry)

    expect(view.operatingSystem).toEqual({
      id: '',
      versionId: '',
      prettyName: '',
      arch: 'x86_64'
    })
  })

  it('parses an empty package struct and a package without a version', async () => {
    installExec({
      apps: '/dev/sda1\n[0] = {\n}\n[1] = {\n  app2_name: solo\n}\n'
    })

    const view = await inspectFilesystem(DISK, registry)

    expect(view.packages).toEqual([{ name: 'solo', version: '' }])
  })

  it('tolerates an empty architecture result', async () => {
    installExec({ arch: '\n' })

    const view = await inspectFilesystem(DISK, registry)

    expect(view.operatingSystem.arch).toBe('')
  })

  it('throws when no operating system is detected (zero roots)', async () => {
    installExec({ roots: '\n  \n' })

    await expect(inspectFilesystem(DISK, registry)).rejects.toThrow(
      /No operating system detected/
    )
  })

  it('throws when multiple operating systems are detected', async () => {
    installExec({ roots: '/dev/sda1\n/dev/sdb1\n' })

    await expect(inspectFilesystem(DISK, registry)).rejects.toThrow(
      /Multiple operating systems detected/
    )
  })

  it('throws when the package database is empty', async () => {
    installExec({ apps: '/dev/sda1\n' })

    await expect(inspectFilesystem(DISK, registry)).rejects.toThrow(
      /package database cannot be enumerated/
    )
  })

  it('throws when /etc/os-release is missing', async () => {
    installExec({ writeOsRelease: false })

    await expect(inspectFilesystem(DISK, registry)).rejects.toThrow(
      /Could not read \/etc\/os-release/
    )
  })
})
