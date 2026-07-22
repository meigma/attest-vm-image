/**
 * Unit tests for src/tools.ts.
 *
 * '@actions/tool-cache', the exec wrapper, the hash helper, '@actions/core',
 * and 'node:fs' are all mocked so no real binary is downloaded, hashed, or
 * executed and the kernel-readability probe is deterministic. The test's own
 * `readFileSync` binds to the real module before the node:fs mock is registered,
 * so fixtures on disk are still readable.
 */
import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import type * as tcModule from '@actions/tool-cache'
import * as core from '../__fixtures__/core.js'
import { exec } from '../__fixtures__/exec.js'

const tc = {
  find: jest.fn<typeof tcModule.find>(),
  downloadTool: jest.fn<typeof tcModule.downloadTool>(),
  extractTar: jest.fn<typeof tcModule.extractTar>(),
  cacheDir: jest.fn<typeof tcModule.cacheDir>(),
  cacheFile: jest.fn<typeof tcModule.cacheFile>()
}
const sha256File = jest.fn<(path: string) => Promise<string>>()
const sha256Buffer = jest.fn<(buf: Buffer) => string>()
const readdirSync = jest.fn<(p: string) => string[]>()
const accessSync = jest.fn<(p: string, mode?: number) => void>()
const chmod = jest.fn<(p: string, mode: number) => Promise<void>>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/tool-cache', () => tc)
jest.unstable_mockModule('../src/exec.js', () => ({ exec }))
jest.unstable_mockModule('../src/hash.js', () => ({ sha256File, sha256Buffer }))
jest.unstable_mockModule('node:fs', () => ({
  readdirSync,
  accessSync,
  promises: { chmod },
  constants: { R_OK: 4 }
}))

const {
  ensureBinary,
  ensureAptPackages,
  toolVersions,
  platformKey,
  PINNED_TOOLS,
  APT_PACKAGES
} = await import('../src/tools.js')

const originalPlatform = process.platform
const originalArch = process.arch

function setPlatform(platform: string, arch: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true
  })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

describe('tools.ts', () => {
  beforeEach(() => {
    setPlatform('linux', 'x64')
  })

  afterEach(() => {
    setPlatform(originalPlatform, originalArch)
    jest.resetAllMocks()
  })

  describe('platformKey', () => {
    it('resolves linux/x64 and linux/arm64', () => {
      setPlatform('linux', 'x64')
      expect(platformKey()).toBe('linux-x64')
      setPlatform('linux', 'arm64')
      expect(platformKey()).toBe('linux-arm64')
    })

    it('throws on a non-linux platform', () => {
      setPlatform('darwin', 'arm64')
      expect(() => platformKey()).toThrow(/only on Linux runners/)
    })

    it('throws on an unsupported architecture', () => {
      setPlatform('linux', 'ppc64')
      expect(() => platformKey()).toThrow(/only x64 and arm64/)
    })
  })

  describe('ensureBinary', () => {
    it('returns the cached directory without downloading when found', async () => {
      tc.find.mockReturnValue('/cache/syft/1.48.0')

      expect(await ensureBinary('syft')).toBe('/cache/syft/1.48.0')
      expect(tc.downloadTool).not.toHaveBeenCalled()
    })

    it('downloads the templated URL, verifies, extracts, and caches on a digest match', async () => {
      tc.find.mockReturnValue('')
      tc.downloadTool.mockResolvedValue('/dl/syft.tgz')
      sha256File.mockResolvedValue(PINNED_TOOLS.syft.sha256['linux-x64'])
      tc.extractTar.mockResolvedValue('/extracted/syft')
      tc.cacheDir.mockResolvedValue('/cache/syft/1.48.0/x64')

      const dir = await ensureBinary('syft')

      expect(tc.downloadTool).toHaveBeenCalledWith(
        'https://github.com/anchore/syft/releases/download/v1.48.0/syft_1.48.0_linux_amd64.tar.gz'
      )
      expect(tc.extractTar).toHaveBeenCalledWith('/dl/syft.tgz')
      expect(tc.cacheDir).toHaveBeenCalledWith(
        '/extracted/syft',
        'syft',
        '1.48.0',
        'linux-x64'
      )
      expect(dir).toBe('/cache/syft/1.48.0/x64')
    })

    it('uses the arm64 arch token and digest on linux/arm64', async () => {
      setPlatform('linux', 'arm64')
      tc.find.mockReturnValue('')
      tc.downloadTool.mockResolvedValue('/dl/grype.tgz')
      sha256File.mockResolvedValue(PINNED_TOOLS.grype.sha256['linux-arm64'])
      tc.extractTar.mockResolvedValue('/extracted/grype')
      tc.cacheDir.mockResolvedValue('/cache/grype')

      await ensureBinary('grype')

      expect(tc.downloadTool).toHaveBeenCalledWith(
        'https://github.com/anchore/grype/releases/download/v0.116.0/grype_0.116.0_linux_arm64.tar.gz'
      )
    })

    it('downloads, verifies, makes executable, and caches the pinned Cosign binary', async () => {
      tc.find.mockReturnValue('')
      tc.downloadTool.mockResolvedValue('/dl/cosign')
      sha256File.mockResolvedValue(PINNED_TOOLS.cosign.sha256['linux-x64'])
      tc.cacheFile.mockResolvedValue('/cache/cosign/3.1.2/linux-x64')
      chmod.mockResolvedValue()

      const dir = await ensureBinary('cosign')

      expect(tc.downloadTool).toHaveBeenCalledWith(
        'https://github.com/sigstore/cosign/releases/download/v3.1.2/cosign-linux-amd64'
      )
      expect(tc.extractTar).not.toHaveBeenCalled()
      expect(chmod).toHaveBeenCalledWith('/dl/cosign', 0o755)
      expect(tc.cacheFile).toHaveBeenCalledWith(
        '/dl/cosign',
        'cosign',
        'cosign',
        '3.1.2',
        'linux-x64'
      )
      expect(chmod).toHaveBeenCalledWith(
        '/cache/cosign/3.1.2/linux-x64/cosign',
        0o755
      )
      expect(dir).toBe('/cache/cosign/3.1.2/linux-x64')
    })

    it('throws before extracting or caching when the digest differs by one byte', async () => {
      tc.find.mockReturnValue('')
      tc.downloadTool.mockResolvedValue('/dl/syft.tgz')
      const good = PINNED_TOOLS.syft.sha256['linux-x64']
      const bad = good.slice(0, -1) + (good.endsWith('4') ? '5' : '4')
      sha256File.mockResolvedValue(bad)

      await expect(ensureBinary('syft')).rejects.toThrow(
        /Integrity check failed for syft/
      )
      expect(tc.extractTar).not.toHaveBeenCalled()
      expect(tc.cacheDir).not.toHaveBeenCalled()
    })

    it('names expected and actual digests in the mismatch error', async () => {
      tc.find.mockReturnValue('')
      tc.downloadTool.mockResolvedValue('/dl/syft.tgz')
      sha256File.mockResolvedValue('a'.repeat(64))

      await expect(ensureBinary('syft')).rejects.toThrow(
        new RegExp(
          `expected sha256 ${PINNED_TOOLS.syft.sha256['linux-x64']}, got ${'a'.repeat(64)}`
        )
      )
    })

    it('propagates the unsupported-platform diagnostic', async () => {
      setPlatform('win32', 'x64')
      await expect(ensureBinary('syft')).rejects.toThrow(
        /only on Linux runners/
      )
    })
  })

  describe('ensureAptPackages', () => {
    it('runs apt-get update, install, and the kernel chmod, then passes the probe', async () => {
      exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      readdirSync.mockReturnValue(['vmlinuz-6.8.0-generic', 'config-6.8.0'])
      accessSync.mockImplementation(() => undefined)

      await ensureAptPackages()

      expect(exec).toHaveBeenCalledWith('sudo', ['apt-get', 'update'])
      expect(exec).toHaveBeenCalledWith('sudo', [
        'apt-get',
        'install',
        '-y',
        '--no-install-recommends',
        'qemu-utils',
        'libguestfs-tools'
      ])
      expect(exec).toHaveBeenCalledWith('sudo', [
        'sh',
        '-c',
        'chmod +r /boot/vmlinuz-*'
      ])
    })

    it('throws when no kernel image is readable after the chmod', async () => {
      exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      readdirSync.mockReturnValue(['vmlinuz-6.8.0-generic'])
      accessSync.mockImplementation(() => {
        throw new Error('EACCES')
      })

      await expect(ensureAptPackages()).rejects.toThrow(
        /No readable kernel image at \/boot\/vmlinuz-\*/
      )
      // The install and chmod were still issued before the probe failed.
      expect(exec).toHaveBeenCalledWith('sudo', [
        'sh',
        '-c',
        'chmod +r /boot/vmlinuz-*'
      ])
    })

    it('throws when /boot cannot be listed', async () => {
      exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
      readdirSync.mockImplementation(() => {
        throw new Error('ENOENT')
      })

      await expect(ensureAptPackages()).rejects.toThrow(
        /supermin appliance must read the host kernel image/
      )
    })
  })

  describe('toolVersions', () => {
    it('includes the pins, dpkg-resolved apt versions, and the action version', async () => {
      const dpkg = readFileSync('__fixtures__/samples/dpkg-query.txt', 'utf8')
      exec.mockResolvedValue({ stdout: dpkg, stderr: '', exitCode: 0 })

      const versions = await toolVersions()
      const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
        name: string
        version: string
      }

      expect(exec).toHaveBeenCalledWith('dpkg-query', [
        '-W',
        '-f',
        '${Package} ${Version}\n',
        ...APT_PACKAGES
      ])
      expect(versions).toContainEqual({ name: 'syft', version: '1.48.0' })
      expect(versions).toContainEqual({ name: 'grype', version: '0.116.0' })
      expect(versions).toContainEqual({
        name: 'qemu-utils',
        version: '1:8.2.2+ds-0ubuntu1.7'
      })
      expect(versions).toContainEqual({
        name: 'libguestfs-tools',
        version: '1.52.0-1ubuntu1'
      })
      expect(versions).toContainEqual({
        name: pkg.name,
        version: pkg.version
      })
      expect(versions.length).toBe(5)
    })

    it('tolerates a dpkg line carrying only a package name', async () => {
      exec.mockResolvedValue({
        stdout: 'qemu-utils\n\n',
        stderr: '',
        exitCode: 0
      })

      const versions = await toolVersions()

      expect(versions).toContainEqual({ name: 'qemu-utils', version: '' })
    })
  })
})
