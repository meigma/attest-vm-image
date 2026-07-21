/**
 * Unit tests for src/checksums.ts.
 *
 * node:fs and the hash helper are REAL: inputs and evidence are written to a
 * real temp directory, digested, and the emitted checksums.txt is parsed back.
 * No external binary is involved.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeChecksums } from '../src/checksums.js'
import { sha256File } from '../src/hash.js'

describe('checksums.ts', () => {
  let dir: string

  const write = (name: string, body: string): string => {
    const p = join(dir, name)
    writeFileSync(p, body)
    return p
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-checksums-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes sha256sum -c compatible lines (two-space separator) in input->evidence order', async () => {
    const diskPath = write('disk.qcow2', 'disk-bytes')
    const metaPath = write('metadata.tar.gz', 'meta-bytes')
    const manifestPath = write('manifest.json', 'manifest-bytes')
    const sbomPath = write('sbom.spdx.json', 'sbom-bytes')
    const vulnPath = write('vulnerability-report.json', 'vuln-bytes')
    const outputPath = join(dir, 'checksums.txt')

    const diskSha = await sha256File(diskPath)

    await writeChecksums({
      diskPath,
      expectedDiskSha256: diskSha,
      extraInputs: [metaPath, manifestPath],
      evidenceFiles: [sbomPath, vulnPath],
      outputPath
    })

    const body = readFileSync(outputPath, 'utf8')
    expect(body.endsWith('\n')).toBe(true)
    const lines = body.trimEnd().split('\n')

    // Order: disk, then extra inputs, then evidence files.
    expect(lines).toEqual([
      `${diskSha}  ${diskPath}`,
      `${await sha256File(metaPath)}  ${metaPath}`,
      `${await sha256File(manifestPath)}  ${manifestPath}`,
      `${await sha256File(sbomPath)}  ${sbomPath}`,
      `${await sha256File(vulnPath)}  ${vulnPath}`
    ])

    // Every data line has exactly the two-space separator.
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}\S/)
    }
  })

  it('writes paths exactly as passed, not normalized', async () => {
    const diskPath = write('disk.qcow2', 'disk-bytes')
    const sbomPath = write('sbom.spdx.json', 'sbom-bytes')
    const outputPath = join(dir, 'checksums.txt')
    const diskSha = await sha256File(diskPath)

    // The disk is referenced through a non-normalized path that still resolves
    // to the same file; its digest must succeed and the string must be
    // reproduced verbatim in the output (never rewritten to a canonical form).
    const messyDiskPath = `${dir}/./disk.qcow2`

    await writeChecksums({
      diskPath: messyDiskPath,
      expectedDiskSha256: diskSha,
      extraInputs: [],
      evidenceFiles: [sbomPath],
      outputPath
    })

    const body = readFileSync(outputPath, 'utf8')
    expect(body).toContain(`  ${messyDiskPath}`)
    expect(body).toContain(`  ${sbomPath}`)
  })

  it('handles no extra inputs and a single evidence file', async () => {
    const diskPath = write('disk.qcow2', 'd')
    const predicatePath = write('validation-predicate.json', 'p')
    const outputPath = join(dir, 'checksums.txt')
    const diskSha = await sha256File(diskPath)

    await writeChecksums({
      diskPath,
      expectedDiskSha256: diskSha,
      extraInputs: [],
      evidenceFiles: [predicatePath],
      outputPath
    })

    const lines = readFileSync(outputPath, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`${diskSha}  ${diskPath}`)
  })

  it('throws the digest-changed diagnostic and writes nothing when the disk changed', async () => {
    const diskPath = write('disk.qcow2', 'disk-bytes')
    const sbomPath = write('sbom.spdx.json', 'sbom-bytes')
    const outputPath = join(dir, 'checksums.txt')

    await expect(
      writeChecksums({
        diskPath,
        expectedDiskSha256: 'f'.repeat(64),
        extraInputs: [],
        evidenceFiles: [sbomPath],
        outputPath
      })
    ).rejects.toThrow(/changed during the run/)

    // The re-digest guard runs before anything is written.
    expect(existsSync(outputPath)).toBe(false)
  })

  it('re-digests the disk before writing (guard is not the recorded value blindly)', async () => {
    const diskPath = write('disk.qcow2', 'disk-bytes')
    const outputPath = join(dir, 'checksums.txt')
    const realSha = await sha256File(diskPath)

    // A correct expected digest passes and the emitted disk line carries the
    // freshly re-digested value.
    await writeChecksums({
      diskPath,
      expectedDiskSha256: realSha,
      extraInputs: [],
      evidenceFiles: [],
      outputPath
    })
    expect(readFileSync(outputPath, 'utf8')).toBe(`${realSha}  ${diskPath}\n`)
  })
})
