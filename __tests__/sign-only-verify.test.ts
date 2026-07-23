/**
 * Unit tests for src/sign-only/verify.ts, the fail-closed evidence handoff
 * re-verification. Real files in a temp directory are used throughout so every
 * digest comparison runs against actual bytes, exactly as in production.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREDICATE_TYPE, STATEMENT_TYPE } from '../src/predicate.js'
import type { Statement } from '../src/predicate.js'
import type { EvidenceManifest } from '../src/manifest.js'
import { verifyEvidenceManifest } from '../src/sign-only/verify.js'

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

const DISK_SHA = sha256('disk-bytes')

describe('sign-only verify', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-sign-only-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A structurally valid, passing statement over the fixture disk digest. */
  const statement = (): Statement =>
    ({
      _type: STATEMENT_TYPE,
      subject: [{ name: 'disk.qcow2', digest: { sha256: DISK_SHA } }],
      predicateType: PREDICATE_TYPE,
      predicate: { result: 'pass' }
    }) as unknown as Statement

  /**
   * Write a complete valid handoff into `dir` and return the manifest path.
   * `mutate` may adjust the manifest document before it is written; recorded
   * evidence paths use a job-A-style `./evidence/` prefix so resolution against
   * the manifest's own directory is always exercised.
   */
  const writeHandoff = (
    mutate: (manifest: EvidenceManifest) => void = () => undefined,
    statementBody: object = statement()
  ): string => {
    const files: Array<{
      role: string
      name: string
      contents: string
      mediaType: string
    }> = [
      {
        role: 'checksums',
        name: 'checksums.txt',
        contents: 'checksums-bytes\n',
        mediaType: 'text/plain'
      },
      {
        role: 'sbom',
        name: 'sbom.spdx.json',
        contents: '{"spdxVersion":"SPDX-2.3"}',
        mediaType: 'application/spdx+json'
      },
      {
        role: 'vulnerability-report',
        name: 'vulnerability-report.json',
        contents: '{"vuln":true}',
        mediaType: 'application/json'
      },
      {
        role: 'validation-report',
        name: 'validation-report.json',
        contents: '{"report":true}',
        mediaType: 'application/json'
      },
      {
        role: 'validation-predicate',
        name: 'validation-predicate.json',
        contents: JSON.stringify(statementBody),
        mediaType: 'application/vnd.in-toto+json'
      }
    ]
    for (const file of files) {
      writeFileSync(join(dir, file.name), file.contents)
    }
    const manifest = {
      schemaVersion: '1',
      result: 'pass',
      artifacts: {
        disk: { path: 'disk.qcow2', sha256: DISK_SHA },
        metadata: null,
        buildManifest: null
      },
      evidence: files.map((file) => ({
        role: file.role,
        path: `./evidence/${file.name}`,
        sha256: sha256(file.contents),
        mediaType: file.mediaType
      }))
    } as EvidenceManifest
    mutate(manifest)
    const manifestPath = join(dir, 'evidence-manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    return manifestPath
  }

  it('verifies a valid handoff and resolves paths against the manifest directory', async () => {
    const manifestPath = writeHandoff()

    const handoff = await verifyEvidenceManifest(manifestPath)

    expect(handoff.manifestDir).toBe(dir)
    expect(handoff.evidence.map((entry) => entry.path)).toEqual([
      join(dir, 'checksums.txt'),
      join(dir, 'sbom.spdx.json'),
      join(dir, 'vulnerability-report.json'),
      join(dir, 'validation-report.json'),
      join(dir, 'validation-predicate.json')
    ])
    // The parsed manifest keeps its recorded job-A paths untouched.
    expect(handoff.manifest.evidence[0].path).toBe('./evidence/checksums.txt')
    expect(handoff.sbom).toEqual({
      path: join(dir, 'sbom.spdx.json'),
      sha256: sha256('{"spdxVersion":"SPDX-2.3"}'),
      format: 'spdx-json'
    })
    expect(handoff.statement._type).toBe(STATEMENT_TYPE)
    expect(handoff.statement.subject[0].digest.sha256).toBe(DISK_SHA)
  })

  it('derives the cyclonedx format from its media type', async () => {
    const manifestPath = writeHandoff((manifest) => {
      manifest.evidence[1].mediaType = 'application/vnd.cyclonedx+json'
    })

    const handoff = await verifyEvidenceManifest(manifestPath)

    expect(handoff.sbom.format).toBe('cyclonedx-json')
  })

  it('rejects a missing manifest', async () => {
    await expect(
      verifyEvidenceManifest(join(dir, 'nope.json'))
    ).rejects.toThrow('does not exist or is not readable')
  })

  it('rejects a manifest that is not JSON', async () => {
    const manifestPath = join(dir, 'evidence-manifest.json')
    writeFileSync(manifestPath, 'not json')

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'not valid JSON'
    )
  })

  it('rejects an unknown schema version', async () => {
    const manifestPath = writeHandoff((manifest) => {
      ;(manifest as { schemaVersion: string }).schemaVersion = '2'
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'not a schemaVersion "1" evidence manifest'
    )
  })

  it('rejects a failing result', async () => {
    const manifestPath = writeHandoff((manifest) => {
      ;(manifest as { result: string }).result = 'fail'
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'a failing result is never signed'
    )
  })

  it('rejects a manifest that already records an attestation URL', async () => {
    const manifestPath = writeHandoff((manifest) => {
      manifest.attestationUrl = 'https://github.com/o/r/attestations/1'
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      're-signing a signed manifest is refused'
    )
  })

  it('rejects a manifest that already contains attestation bundles', async () => {
    const manifestPath = writeHandoff((manifest) => {
      manifest.evidence.push({
        role: 'validation-attestation',
        path: './evidence/attestations/validation.sigstore.json',
        sha256: sha256('bundle'),
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json'
      } as EvidenceManifest['evidence'][number])
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'already contains attestation bundles'
    )
  })

  it('rejects missing or reordered evidence roles', async () => {
    const missing = writeHandoff((manifest) => {
      manifest.evidence.splice(2, 1)
    })
    await expect(verifyEvidenceManifest(missing)).rejects.toThrow(
      'must carry exactly the evidence roles'
    )

    const reordered = writeHandoff((manifest) => {
      manifest.evidence.reverse()
    })
    await expect(verifyEvidenceManifest(reordered)).rejects.toThrow(
      'must carry exactly the evidence roles'
    )
  })

  it('rejects a malformed recorded digest', async () => {
    const manifestPath = writeHandoff((manifest) => {
      manifest.evidence[0].sha256 = 'ZZ'.repeat(32)
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'malformed sha256 for role "checksums"'
    )
  })

  it('rejects duplicate evidence basenames', async () => {
    const manifestPath = writeHandoff((manifest) => {
      manifest.evidence[4].path = './evidence/validation-report.json'
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'duplicate evidence basename'
    )
  })

  it('rejects a missing evidence file', async () => {
    const manifestPath = writeHandoff()
    unlinkSync(join(dir, 'checksums.txt'))

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      '(role "checksums") does not exist or is not readable'
    )
  })

  it('rejects a tampered evidence file', async () => {
    const manifestPath = writeHandoff()
    writeFileSync(join(dir, 'sbom.spdx.json'), '{"tampered":true}')

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'does not match its recorded digest'
    )
  })

  it('rejects an unsupported SBOM media type', async () => {
    const manifestPath = writeHandoff((manifest) => {
      manifest.evidence[1].mediaType =
        'application/json' as EvidenceManifest['evidence'][number]['mediaType']
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'unsupported SBOM media type'
    )
  })

  it('rejects a predicate file that is not an in-toto statement', async () => {
    const manifestPath = writeHandoff(() => undefined, { foo: 1 })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'is not a'
    )
  })

  it('rejects a statement whose subject digest mismatches the manifest disk', async () => {
    const other = statement()
    other.subject[0].digest.sha256 = sha256('other-disk')
    const manifestPath = writeHandoff(() => undefined, other)

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'subject digest does not match'
    )
  })

  it('rejects a statement with a non-passing predicate result', async () => {
    const failing = statement()
    ;(failing.predicate as { result: string }).result = 'fail'
    const manifestPath = writeHandoff(() => undefined, failing)

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'non-passing result'
    )
  })

  it('re-checks the disk digest only when disk-path is provided', async () => {
    const manifestPath = writeHandoff()
    const diskPath = join(dir, 'disk.qcow2')
    writeFileSync(diskPath, 'disk-bytes')

    await expect(
      verifyEvidenceManifest(manifestPath, { diskPath })
    ).resolves.toBeDefined()

    writeFileSync(diskPath, 'other-bytes')
    await expect(
      verifyEvidenceManifest(manifestPath, { diskPath })
    ).rejects.toThrow("does not match the manifest's recorded disk digest")

    await expect(
      verifyEvidenceManifest(manifestPath, { diskPath: join(dir, 'gone') })
    ).rejects.toThrow('does not exist or is not readable')
  })

  it('rejects a manifest without a well-formed disk artifact', async () => {
    const manifestPath = writeHandoff((manifest) => {
      ;(manifest.artifacts.disk as unknown as { sha256: string }).sha256 =
        'nope'
    })

    await expect(verifyEvidenceManifest(manifestPath)).rejects.toThrow(
      'well-formed artifacts.disk entry'
    )
  })

  it('accepts a well-formed metadata artifact and rejects a malformed one', async () => {
    const metadataPath = writeHandoff((manifest) => {
      manifest.artifacts.metadata = {
        path: 'incus.tar.xz',
        sha256: sha256('metadata-bytes')
      }
    })
    await expect(verifyEvidenceManifest(metadataPath)).resolves.toBeDefined()

    const malformed = writeHandoff((manifest) => {
      manifest.artifacts.metadata = {
        path: 'incus.tar.xz',
        sha256: 'short'
      }
    })
    await expect(verifyEvidenceManifest(malformed)).rejects.toThrow(
      'malformed artifacts.metadata entry'
    )
  })
})
