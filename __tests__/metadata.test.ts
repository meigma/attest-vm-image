/**
 * Unit tests for src/metadata.ts.
 *
 * The exec wrapper and the hash helper are mocked so no real tar runs and no
 * real digest is computed; `tar -tvf` listings come from __fixtures__/samples.
 * The `tar -xf` mock writes a real metadata.yaml into the real extraction temp
 * directory so js-yaml parsing runs against actual bytes. node:fs is NOT mocked.
 */
import { jest } from '@jest/globals'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'
import { exec } from '../__fixtures__/exec.js'

const sha256File = jest.fn<(path: string) => Promise<string>>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/exec.js', () => ({ exec }))
jest.unstable_mockModule('../src/hash.js', () => ({ sha256File }))

const { validateMetadata } = await import('../src/metadata.js')
const { CleanupRegistry } = await import('../src/cleanup.js')

const sample = (name: string): string =>
  readFileSync(join('__fixtures__/samples', name), 'utf8')

const DIGEST = 'b'.repeat(64)
const ARCHIVE = '/tmp/incus.tar.xz'

// Install an exec mock: `tar -tvf` returns `listing`; `tar -xf` writes
// `yamlContent` (when provided) as metadata.yaml into the extraction directory.
function installExec(listing: string, yamlContent?: string): void {
  exec.mockImplementation(async (_cmd, args = []) => {
    if (args.includes('-tvf')) {
      return { stdout: listing, stderr: '', exitCode: 0 }
    }
    if (args.includes('-xf')) {
      const dirIndex = args.indexOf('-C')
      const dir = args[dirIndex + 1]
      if (yamlContent !== undefined) {
        writeFileSync(join(dir, 'metadata.yaml'), yamlContent)
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  })
}

describe('metadata.ts', () => {
  let registry: InstanceType<typeof CleanupRegistry>

  beforeEach(() => {
    registry = new CleanupRegistry()
    sha256File.mockResolvedValue(DIGEST)
  })

  afterEach(async () => {
    await registry.drain()
    jest.resetAllMocks()
  })

  const unsafe: Array<[string, string, RegExp]> = [
    ['absolute path', 'tar-absolute.txt', /absolute paths are not allowed/],
    ['dot-dot traversal', 'tar-dotdot.txt', /traversal is not allowed/],
    [
      'symlink escape',
      'tar-symlink-escape.txt',
      /symlink target .* escapes the extraction root/
    ],
    [
      'hardlink escape',
      'tar-hardlink-escape.txt',
      /hardlink target .* escapes the extraction root/
    ],
    ['device node', 'tar-device.txt', /device nodes are not allowed/],
    ['fifo', 'tar-fifo.txt', /FIFOs are not allowed/],
    ['unknown file type', 'tar-socket.txt', /unsupported file type "\?"/],
    [
      'symlink-chain escape via a symlinked parent',
      'tar-symlink-parent-escape.txt',
      /a parent path component .* is a symlink/
    ]
  ]

  it.each(unsafe)(
    'rejects an unsafe archive entry: %s',
    async (_label, fixture, pattern) => {
      installExec(sample(fixture))
      await expect(validateMetadata(ARCHIVE, registry)).rejects.toThrow(pattern)
    }
  )

  it('proves every unsafe diagnostic is distinct', async () => {
    const messages = new Set<string>()
    for (const [, fixture] of unsafe) {
      installExec(sample(fixture))
      await validateMetadata(ARCHIVE, registry).catch((e: Error) =>
        messages.add(e.message)
      )
    }
    expect(messages.size).toBe(unsafe.length)
  })

  it('accepts a valid archive and returns sha256 + properties', async () => {
    installExec(sample('tar-valid.txt'), sample('metadata-valid.yaml'))

    const result = await validateMetadata(ARCHIVE, registry)

    expect(result.sha256).toBe(DIGEST)
    expect(result.properties).toEqual({
      architecture: 'x86_64',
      description: 'Ubuntu noble 24.04',
      os: 'Ubuntu',
      release: 'noble',
      variant: 'cloud'
    })
    expect(sha256File).toHaveBeenCalledWith(ARCHIVE)
    expect(exec).toHaveBeenCalledWith('tar', ['-tvf', ARCHIVE])
  })

  it('extracts with --no-same-owner into a fresh temp directory', async () => {
    installExec(sample('tar-valid.txt'), sample('metadata-valid.yaml'))

    await validateMetadata(ARCHIVE, registry)

    expect(exec).toHaveBeenCalledWith(
      'tar',
      expect.arrayContaining(['-xf', ARCHIVE, '-C', '--no-same-owner'])
    )
  })

  it('rejects an archive missing metadata.yaml', async () => {
    installExec(sample('tar-no-metadata.txt'))
    await expect(validateMetadata(ARCHIVE, registry)).rejects.toThrow(
      /does not contain a metadata.yaml/
    )
  })

  it('rejects metadata.yaml missing a required field', async () => {
    installExec(sample('tar-valid.txt'), sample('metadata-missing-fields.yaml'))
    await expect(validateMetadata(ARCHIVE, registry)).rejects.toThrow(
      /missing the required field "creation_date"/
    )
  })

  it('rejects a null metadata.yaml naming the missing architecture field', async () => {
    installExec(sample('tar-valid.txt'), 'null\n')
    await expect(validateMetadata(ARCHIVE, registry)).rejects.toThrow(
      /missing the required field "architecture"/
    )
  })

  it('fails closed on an unparseable tar listing line', async () => {
    installExec(sample('tar-malformed.txt'))
    await expect(validateMetadata(ARCHIVE, registry)).rejects.toThrow(
      /Unparseable tar listing line/
    )
  })

  it('returns empty properties when metadata.yaml has none', async () => {
    installExec(
      sample('tar-valid.txt'),
      'architecture: x86_64\ncreation_date: 1717243200\n'
    )

    const result = await validateMetadata(ARCHIVE, registry)

    expect(result.properties).toEqual({})
  })
})
