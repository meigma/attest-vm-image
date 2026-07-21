/**
 * Unit tests for src/disk.ts.
 *
 * The exec wrapper and the hash helper are mocked so no real qemu-img runs and
 * no real digest is computed; `qemu-img` JSON comes from __fixtures__/samples.
 * `fs.stat` runs against real temp files so the missing/irregular-file branch is
 * exercised honestly.
 */
import { jest } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import * as core from '../__fixtures__/core.js'
import { exec } from '../__fixtures__/exec.js'

const sha256File = jest.fn<(path: string) => Promise<string>>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/exec.js', () => ({ exec }))
jest.unstable_mockModule('../src/hash.js', () => ({ sha256File }))

const { validateDisk } = await import('../src/disk.js')

const sample = (name: string): string =>
  readFileSync(join('__fixtures__/samples', name), 'utf8')

const INFO_QCOW2 = sample('qemu-img-info-qcow2.json')
const INFO_RAW = sample('qemu-img-info-raw.json')
const INFO_BACKING = sample('qemu-img-info-backing.json')
const CHECK_OK = sample('qemu-img-check-ok.json')
const CHECK_CORRUPT = sample('qemu-img-check-corrupt.json')

const DIGEST = 'a'.repeat(64)

// Route exec calls to the right fixture by subcommand.
function mockQemu(info: string, check: string, checkExit = 0): void {
  exec.mockImplementation(async (_cmd, args = []) => {
    if (args.includes('info')) {
      return { stdout: info, stderr: '', exitCode: 0 }
    }
    return { stdout: check, stderr: '', exitCode: checkExit }
  })
}

describe('disk.ts', () => {
  let dir: string
  let disk: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-disk-'))
    disk = join(dir, 'disk.qcow2')
    writeFileSync(disk, 'qcow2bytes')
    sha256File.mockResolvedValue(DIGEST)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    jest.resetAllMocks()
  })

  it('accepts a healthy qcow2 and returns its facts', async () => {
    mockQemu(INFO_QCOW2, CHECK_OK)

    const result = await validateDisk(disk)

    expect(result).toEqual({
      sha256: DIGEST,
      sizeBytes: 10,
      virtualSize: 2147483648,
      actualSize: 200704,
      compat: '1.1'
    })
    expect(sha256File).toHaveBeenCalledWith(disk)
    expect(exec).toHaveBeenCalledWith('qemu-img', [
      'info',
      '--output=json',
      disk
    ])
  })

  it('rejects a missing file distinctly', async () => {
    await expect(validateDisk(join(dir, 'nope.qcow2'))).rejects.toThrow(
      /does not exist/
    )
  })

  it('rejects a non-regular file distinctly', async () => {
    await expect(validateDisk(dir)).rejects.toThrow(/is not a regular file/)
  })

  it('rejects a non-QCOW2 format distinctly', async () => {
    mockQemu(INFO_RAW, CHECK_OK)
    await expect(validateDisk(disk)).rejects.toThrow(/is not a QCOW2 image/)
  })

  it('rejects an unexpected backing file distinctly', async () => {
    mockQemu(INFO_BACKING, CHECK_OK)
    await expect(validateDisk(disk)).rejects.toThrow(
      /unexpected backing file .*not supported in v1/
    )
  })

  it('rejects a corrupt image distinctly (reported corruptions)', async () => {
    mockQemu(INFO_QCOW2, CHECK_CORRUPT, 2)
    await expect(validateDisk(disk)).rejects.toThrow(/The image is corrupt/)
  })

  it('rejects a corrupt image on a non-zero check exit with a clean JSON body', async () => {
    mockQemu(INFO_QCOW2, CHECK_OK, 3)
    await expect(validateDisk(disk)).rejects.toThrow(/integrity check/)
  })

  it('names the format "unknown" when qemu-img reports no format', async () => {
    mockQemu('{"virtual-size":1}', CHECK_OK)
    await expect(validateDisk(disk)).rejects.toThrow(/format "unknown"/)
  })

  it('defaults absent size/compat fields to zero and empty string', async () => {
    mockQemu('{"format":"qcow2"}', '{}')

    const result = await validateDisk(disk)

    expect(result).toEqual({
      sha256: DIGEST,
      sizeBytes: 10,
      virtualSize: 0,
      actualSize: 0,
      compat: ''
    })
  })

  it('handles format-specific present without a data object', async () => {
    mockQemu('{"format":"qcow2","format-specific":{"type":"qcow2"}}', CHECK_OK)
    expect((await validateDisk(disk)).compat).toBe('')
  })

  it('handles a data object without a compat field', async () => {
    mockQemu('{"format":"qcow2","format-specific":{"data":{}}}', CHECK_OK)
    expect((await validateDisk(disk)).compat).toBe('')
  })

  it('fails on reported corruptions even with a zero exit code', async () => {
    mockQemu(INFO_QCOW2, '{"corruptions":5,"check-errors":0}', 0)
    await expect(validateDisk(disk)).rejects.toThrow(/The image is corrupt/)
  })

  it('fails on reported check-errors even with a zero exit code', async () => {
    mockQemu(INFO_QCOW2, '{"corruptions":0,"check-errors":4}', 0)
    await expect(validateDisk(disk)).rejects.toThrow(/The image is corrupt/)
  })

  it('proves the four failure messages are all distinct', async () => {
    const messages = new Set<string>()

    await validateDisk(join(dir, 'gone.qcow2')).catch((e: Error) =>
      messages.add(e.message)
    )
    mockQemu(INFO_RAW, CHECK_OK)
    await validateDisk(disk).catch((e: Error) => messages.add(e.message))
    mockQemu(INFO_BACKING, CHECK_OK)
    await validateDisk(disk).catch((e: Error) => messages.add(e.message))
    mockQemu(INFO_QCOW2, CHECK_CORRUPT, 2)
    await validateDisk(disk).catch((e: Error) => messages.add(e.message))

    expect(messages.size).toBe(4)
  })
})
