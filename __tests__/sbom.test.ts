/**
 * Unit tests for src/sbom.ts.
 *
 * The exec wrapper and the tool resolver are mocked so no real Syft runs; SBOM
 * bytes come from __fixtures__/samples or inline documents. The hash helper and
 * node:fs are REAL: the SBOM is written to a real temp file and re-hashed, so
 * the test proves the returned digest is computed AFTER the subject digest is
 * embedded.
 */
import { jest } from '@jest/globals'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'
import { exec } from '../__fixtures__/exec.js'

const ensureBinary = jest.fn<() => Promise<string>>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/exec.js', () => ({ exec }))
jest.unstable_mockModule('../src/tools.js', () => ({ ensureBinary }))

const { generateSbom } = await import('../src/sbom.js')
const { sha256File } = await import('../src/hash.js')
import type { FsView } from '../src/inspect.js'

const sample = (name: string): string =>
  readFileSync(join('__fixtures__/samples', name), 'utf8')

const SPDX = sample('syft-spdx.json')
const CYCLONEDX = sample('syft-cyclonedx.json')
const EMPTY_CDX = sample('syft-empty.json')

const DIGEST = 'a'.repeat(64)
const FSVIEW = { mountPath: '/mnt' } as unknown as FsView

function stdout(body: string, exitCode = 0): void {
  exec.mockResolvedValue({ stdout: body, stderr: '', exitCode })
}

describe('sbom.ts', () => {
  let dir: string
  let out: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-sbom-'))
    out = join(dir, 'sbom.json')
    ensureBinary.mockResolvedValue('/opt/syft')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    jest.resetAllMocks()
  })

  it('maps spdx-json to the syft spdx-json output flag', async () => {
    stdout(SPDX)

    await generateSbom(FSVIEW, 'spdx-json', DIGEST, out)

    expect(exec).toHaveBeenCalledWith(
      join('/opt/syft', 'syft'),
      ['scan', 'dir:/mnt', '-o', 'spdx-json'],
      expect.objectContaining({ ignoreReturnCode: true })
    )
  })

  it('maps cyclonedx-json to the syft cyclonedx-json output flag', async () => {
    stdout(CYCLONEDX)

    await generateSbom(FSVIEW, 'cyclonedx-json', DIGEST, out)

    expect(exec).toHaveBeenCalledWith(
      join('/opt/syft', 'syft'),
      ['scan', 'dir:/mnt', '-o', 'cyclonedx-json'],
      expect.objectContaining({ ignoreReturnCode: true })
    )
  })

  it('resolves the syft binary via ensureBinary', async () => {
    stdout(SPDX)

    await generateSbom(FSVIEW, 'spdx-json', DIGEST, out)

    expect(ensureBinary).toHaveBeenCalledWith('syft')
  })

  it('throws a distinct message when syft exits non-zero and writes nothing', async () => {
    exec.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 2 })

    await expect(
      generateSbom(FSVIEW, 'spdx-json', DIGEST, out)
    ).rejects.toThrow(/\(exit code 2\)[\s\S]*boom/)
    expect(() => readFileSync(out)).toThrow()
  })

  it('throws without a stderr suffix when syft exits non-zero with no stderr', async () => {
    exec.mockResolvedValue({ stdout: '', stderr: '   ', exitCode: 3 })

    await expect(
      generateSbom(FSVIEW, 'spdx-json', DIGEST, out)
    ).rejects.toThrow(/exit code 3\) for "\/mnt"\.$/)
  })

  it('embeds the disk digest as a SHA256 checksum on the described SPDX package', async () => {
    stdout(SPDX)

    const result = await generateSbom(FSVIEW, 'spdx-json', DIGEST, out)

    const doc = JSON.parse(readFileSync(out, 'utf8'))
    const root = doc.packages.find(
      (p: { SPDXID: string }) =>
        p.SPDXID === 'SPDXRef-DocumentRoot-Directory-mnt'
    )
    expect(root.checksums).toContainEqual({
      algorithm: 'SHA256',
      checksumValue: DIGEST
    })
    expect(result.format).toBe('spdx-json')
    expect(result.path).toBe(out)
  })

  it('resolves the described SPDX element via a DESCRIBES relationship when documentDescribes is absent', async () => {
    stdout(
      JSON.stringify({
        spdxVersion: 'SPDX-2.3',
        packages: [
          { name: 'root', SPDXID: 'SPDXRef-Root' },
          { name: 'other', SPDXID: 'SPDXRef-Other' }
        ],
        relationships: [
          {
            spdxElementId: 'SPDXRef-DOCUMENT',
            relatedSpdxElement: 'SPDXRef-Root',
            relationshipType: 'DESCRIBES'
          }
        ]
      })
    )

    await generateSbom(FSVIEW, 'spdx-json', DIGEST, out)

    const doc = JSON.parse(readFileSync(out, 'utf8'))
    const root = doc.packages.find(
      (p: { SPDXID: string }) => p.SPDXID === 'SPDXRef-Root'
    )
    expect(root.checksums).toEqual([
      { algorithm: 'SHA256', checksumValue: DIGEST }
    ])
    expect(
      doc.packages.find((p: { SPDXID: string }) => p.SPDXID === 'SPDXRef-Other')
        .checksums
    ).toBeUndefined()
  })

  it('appends to an existing SPDX checksums array on the described package', async () => {
    stdout(
      JSON.stringify({
        spdxVersion: 'SPDX-2.3',
        documentDescribes: ['SPDXRef-Root'],
        packages: [
          {
            name: 'root',
            SPDXID: 'SPDXRef-Root',
            checksums: [{ algorithm: 'SHA1', checksumValue: 'abc' }]
          },
          { name: 'bash', SPDXID: 'SPDXRef-Package-deb-bash-1111' }
        ]
      })
    )

    await generateSbom(FSVIEW, 'spdx-json', DIGEST, out)

    const doc = JSON.parse(readFileSync(out, 'utf8'))
    expect(doc.packages[0].checksums).toEqual([
      { algorithm: 'SHA1', checksumValue: 'abc' },
      { algorithm: 'SHA256', checksumValue: DIGEST }
    ])
  })

  it('throws when no SPDX package matches the DESCRIBES relationship', async () => {
    stdout(
      JSON.stringify({
        spdxVersion: 'SPDX-2.3',
        packages: [{ name: 'orphan', SPDXID: 'SPDXRef-Orphan' }]
      })
    )

    await expect(
      generateSbom(FSVIEW, 'spdx-json', DIGEST, out)
    ).rejects.toThrow(/no package matched the document DESCRIBES relationship/)
  })

  it('embeds the disk digest on metadata.component.hashes for CycloneDX', async () => {
    stdout(CYCLONEDX)

    await generateSbom(FSVIEW, 'cyclonedx-json', DIGEST, out)

    const doc = JSON.parse(readFileSync(out, 'utf8'))
    expect(doc.metadata.component.hashes).toEqual([
      { alg: 'SHA-256', content: DIGEST }
    ])
  })

  it('creates metadata.component defensively when CycloneDX omits it', async () => {
    stdout(
      JSON.stringify({ bomFormat: 'CycloneDX', components: [{ name: 'x' }] })
    )

    await generateSbom(FSVIEW, 'cyclonedx-json', DIGEST, out)

    const doc = JSON.parse(readFileSync(out, 'utf8'))
    expect(doc.metadata.component.hashes).toEqual([
      { alg: 'SHA-256', content: DIGEST }
    ])
  })

  it('fails on zero SPDX packages (empty array and absent array)', async () => {
    stdout(JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [] }))
    await expect(
      generateSbom(FSVIEW, 'spdx-json', DIGEST, out)
    ).rejects.toThrow(/zero packages/)

    stdout(JSON.stringify({ spdxVersion: 'SPDX-2.3' }))
    await expect(
      generateSbom(FSVIEW, 'spdx-json', DIGEST, out)
    ).rejects.toThrow(/zero packages/)
  })

  it('fails when only the synthetic SPDX root package is present (real syft empty shape)', async () => {
    // Real syft emits a `SPDXRef-DocumentRoot-Directory-*` root package plus a
    // DESCRIBES relationship even for a directory with no software packages. The
    // fail-closed count must exclude that synthetic root and still reject.
    stdout(
      JSON.stringify({
        spdxVersion: 'SPDX-2.3',
        packages: [
          { name: 'mnt', SPDXID: 'SPDXRef-DocumentRoot-Directory-mnt' }
        ],
        relationships: [
          {
            spdxElementId: 'SPDXRef-DOCUMENT',
            relatedSpdxElement: 'SPDXRef-DocumentRoot-Directory-mnt',
            relationshipType: 'DESCRIBES'
          }
        ]
      })
    )

    await expect(
      generateSbom(FSVIEW, 'spdx-json', DIGEST, out)
    ).rejects.toThrow(/zero packages/)
    expect(() => readFileSync(out)).toThrow()
  })

  it('fails on zero CycloneDX components (empty array and absent array)', async () => {
    stdout(EMPTY_CDX)
    await expect(
      generateSbom(FSVIEW, 'cyclonedx-json', DIGEST, out)
    ).rejects.toThrow(/zero components/)

    stdout(JSON.stringify({ bomFormat: 'CycloneDX' }))
    await expect(
      generateSbom(FSVIEW, 'cyclonedx-json', DIGEST, out)
    ).rejects.toThrow(/zero components/)
  })

  it('returns a sha256 that re-hashes the written, post-processed file (both formats)', async () => {
    stdout(SPDX)
    const spdx = await generateSbom(FSVIEW, 'spdx-json', DIGEST, out)
    expect(spdx.sha256).toBe(await sha256File(out))

    const out2 = join(dir, 'sbom.cdx.json')
    stdout(CYCLONEDX)
    const cdx = await generateSbom(FSVIEW, 'cyclonedx-json', DIGEST, out2)
    expect(cdx.sha256).toBe(await sha256File(out2))
  })
})
