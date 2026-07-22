/** Unit tests for the versioned evidence handoff manifest. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVIDENCE_MEDIA_TYPES, writeEvidenceManifest } from '../src/manifest.js'
import type { EvidenceSource } from '../src/manifest.js'

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

describe('evidence manifest', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-manifest-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const source = (
    role: EvidenceSource['role'],
    name: string,
    contents: string,
    mediaType: EvidenceSource['mediaType']
  ): EvidenceSource => {
    const filePath = join(dir, name)
    writeFileSync(filePath, contents)
    return { role, path: filePath, mediaType }
  }

  it('writes a deterministic unsigned manifest with null optional artifacts and exact file hashes', async () => {
    const evidence = [
      source(
        'checksums',
        'checksums.txt',
        'checksums-bytes\n',
        EVIDENCE_MEDIA_TYPES.checksums
      ),
      source(
        'sbom',
        'sbom.spdx.json',
        '{"sbom":true}',
        EVIDENCE_MEDIA_TYPES.spdx
      ),
      source(
        'vulnerability-report',
        'vulnerability-report.json',
        '{"matches":[]}',
        EVIDENCE_MEDIA_TYPES.json
      ),
      source(
        'validation-report',
        'validation-report.json',
        '{"result":"pass"}',
        EVIDENCE_MEDIA_TYPES.json
      ),
      source(
        'validation-predicate',
        'validation-predicate.json',
        '{"predicateType":"example"}',
        EVIDENCE_MEDIA_TYPES.inToto
      )
    ]
    const outputPath = join(dir, 'evidence-manifest.json')

    const manifest = await writeEvidenceManifest({
      outputPath,
      result: 'pass',
      artifacts: {
        disk: { path: 'build/disk.qcow2', sha256: 'a'.repeat(64) }
      },
      evidence
    })

    expect(manifest).toEqual({
      schemaVersion: '1',
      result: 'pass',
      artifacts: {
        disk: { path: 'build/disk.qcow2', sha256: 'a'.repeat(64) },
        metadata: null,
        buildManifest: null
      },
      evidence: evidence.map((entry) => ({
        role: entry.role,
        path: entry.path,
        sha256: sha256(readFileSync(entry.path, 'utf8')),
        mediaType: entry.mediaType
      }))
    })
    expect(manifest.evidence.map((entry) => entry.role)).toEqual([
      'checksums',
      'sbom',
      'vulnerability-report',
      'validation-report',
      'validation-predicate'
    ])
    expect(manifest.evidence.some((entry) => entry.path === outputPath)).toBe(
      false
    )
    expect(manifest).not.toHaveProperty('attestationUrl')
    expect(readFileSync(outputPath, 'utf8')).toBe(
      JSON.stringify(manifest, null, 2)
    )
  })

  it('includes optional artifacts and all three signed bundles with stable roles and media types', async () => {
    const evidence = [
      source(
        'provenance-attestation',
        'provenance.sigstore.json',
        'provenance-bundle',
        EVIDENCE_MEDIA_TYPES.sigstoreBundle
      ),
      source(
        'sbom-attestation',
        'sbom.sigstore.json',
        'sbom-bundle',
        EVIDENCE_MEDIA_TYPES.sigstoreBundle
      ),
      source(
        'validation-attestation',
        'validation.sigstore.json',
        'validation-bundle',
        EVIDENCE_MEDIA_TYPES.sigstoreBundle
      )
    ]

    const manifest = await writeEvidenceManifest({
      outputPath: join(dir, 'evidence-manifest.json'),
      result: 'pass',
      artifacts: {
        disk: { path: 'disk.qcow2', sha256: 'a'.repeat(64) },
        metadata: { path: 'incus.tar.xz', sha256: 'b'.repeat(64) },
        buildManifest: { path: 'build.json', sha256: 'c'.repeat(64) }
      },
      evidence,
      attestationUrl: 'https://github.com/meigma/example/attestations/42'
    })

    expect(manifest.artifacts).toEqual({
      disk: { path: 'disk.qcow2', sha256: 'a'.repeat(64) },
      metadata: { path: 'incus.tar.xz', sha256: 'b'.repeat(64) },
      buildManifest: { path: 'build.json', sha256: 'c'.repeat(64) }
    })
    expect(manifest.evidence).toEqual(
      evidence.map((entry) => ({
        role: entry.role,
        path: entry.path,
        sha256: sha256(readFileSync(entry.path, 'utf8')),
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json'
      }))
    )
    expect(manifest.attestationUrl).toBe(
      'https://github.com/meigma/example/attestations/42'
    )
  })
})
