/**
 * Unit tests for src/sign-only/main.ts, the sign-only orchestration. Inputs,
 * verification, signer selection, manifest writing, and node:fs are all mocked
 * so the tests assert pure wiring: what the signer receives, how the manifest
 * is atomically promoted, and how failures leave the handoff untouched.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import type { SignOnlyInputs } from '../src/sign-only/inputs.js'
import type { VerifiedHandoff } from '../src/sign-only/verify.js'
import type { SignContext, SignResult } from '../src/sign/types.js'
import type { Statement } from '../src/predicate.js'

const parseSignOnlyInputs = jest.fn<() => SignOnlyInputs>()
const verifyEvidenceManifest =
  jest.fn<(path: string, options?: object) => Promise<VerifiedHandoff>>()
const sign = jest.fn<(ctx: SignContext) => Promise<SignResult>>()
const selectSigner = jest.fn<() => { sign: typeof sign } | null>()
const writeEvidenceManifest = jest.fn<() => Promise<object>>()
const rename = jest.fn<() => Promise<void>>()
const rm = jest.fn<() => Promise<void>>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/sign-only/inputs.js', () => ({
  parseSignOnlyInputs
}))
jest.unstable_mockModule('../src/sign-only/verify.js', () => ({
  verifyEvidenceManifest
}))
jest.unstable_mockModule('../src/sign/index.js', () => ({ selectSigner }))
jest.unstable_mockModule('../src/manifest.js', () => ({
  writeEvidenceManifest,
  EVIDENCE_MEDIA_TYPES: {
    sigstoreBundle: 'application/vnd.dev.sigstore.bundle.v0.3+json'
  }
}))
jest.unstable_mockModule('node:fs', () => ({ promises: { rename, rm } }))

const { run } = await import('../src/sign-only/main.js')

const DISK_SHA = 'a'.repeat(64)

const inputs = (): SignOnlyInputs => ({
  evidenceManifestPath: '/work/evidence/evidence-manifest.json',
  diskPath: undefined,
  signer: 'cosign-key',
  signingKey: 'integration.key',
  githubToken: ''
})

const handoff = (): VerifiedHandoff => ({
  manifest: {
    schemaVersion: '1',
    result: 'pass',
    artifacts: {
      disk: { path: 'disk.qcow2', sha256: DISK_SHA },
      metadata: null,
      buildManifest: null
    },
    evidence: []
  },
  manifestDir: '/work/evidence',
  evidence: [
    {
      role: 'checksums',
      path: '/work/evidence/checksums.txt',
      sha256: 'b'.repeat(64),
      mediaType: 'text/plain'
    },
    {
      role: 'sbom',
      path: '/work/evidence/sbom.spdx.json',
      sha256: 'c'.repeat(64),
      mediaType: 'application/spdx+json'
    },
    {
      role: 'vulnerability-report',
      path: '/work/evidence/vulnerability-report.json',
      sha256: 'd'.repeat(64),
      mediaType: 'application/json'
    },
    {
      role: 'validation-report',
      path: '/work/evidence/validation-report.json',
      sha256: 'e'.repeat(64),
      mediaType: 'application/json'
    },
    {
      role: 'validation-predicate',
      path: '/work/evidence/validation-predicate.json',
      sha256: 'f'.repeat(64),
      mediaType: 'application/vnd.in-toto+json'
    }
  ],
  sbom: {
    path: '/work/evidence/sbom.spdx.json',
    sha256: 'c'.repeat(64),
    format: 'spdx-json'
  },
  statement: { _type: 'statement' } as unknown as Statement
})

const signResult = (): SignResult => ({
  bundleDir: '/work/evidence/attestations',
  bundles: [
    {
      role: 'provenance-attestation',
      path: '/work/evidence/attestations/provenance.sigstore.json'
    },
    {
      role: 'sbom-attestation',
      path: '/work/evidence/attestations/sbom.sigstore.json'
    },
    {
      role: 'validation-attestation',
      path: '/work/evidence/attestations/validation.sigstore.json'
    }
  ]
})

describe('sign-only main', () => {
  beforeEach(() => {
    parseSignOnlyInputs.mockReturnValue(inputs())
    verifyEvidenceManifest.mockResolvedValue(handoff())
    selectSigner.mockReturnValue({ sign })
    sign.mockResolvedValue(signResult())
    writeEvidenceManifest.mockResolvedValue({})
    rename.mockResolvedValue(undefined)
    rm.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('verifies, signs, and atomically promotes the signed manifest', async () => {
    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(verifyEvidenceManifest).toHaveBeenCalledWith(
      '/work/evidence/evidence-manifest.json',
      { diskPath: undefined }
    )
    expect(sign).toHaveBeenCalledWith({
      disk: { path: 'disk.qcow2', sha256: DISK_SHA },
      metadata: undefined,
      sbom: {
        path: '/work/evidence/sbom.spdx.json',
        sha256: 'c'.repeat(64),
        format: 'spdx-json'
      },
      statement: { _type: 'statement' },
      outputDir: '/work/evidence'
    })

    const written = writeEvidenceManifest.mock.calls[0][0] as {
      outputPath: string
      result: string
      artifacts: object
      evidence: Array<{ role: string; mediaType: string }>
      attestationUrl?: string
    }
    expect(written.outputPath).toBe('/work/evidence/.evidence-manifest.tmp')
    expect(written.result).toBe('pass')
    expect(written.artifacts).toEqual({
      disk: { path: 'disk.qcow2', sha256: DISK_SHA }
    })
    expect(written.evidence.map((entry) => entry.role)).toEqual([
      'checksums',
      'sbom',
      'vulnerability-report',
      'validation-report',
      'validation-predicate',
      'provenance-attestation',
      'sbom-attestation',
      'validation-attestation'
    ])
    expect(
      written.evidence
        .slice(5)
        .every(
          (entry) =>
            entry.mediaType === 'application/vnd.dev.sigstore.bundle.v0.3+json'
        )
    ).toBe(true)
    expect(written.attestationUrl).toBeUndefined()
    expect(rename).toHaveBeenCalledWith(
      '/work/evidence/.evidence-manifest.tmp',
      '/work/evidence/evidence-manifest.json'
    )

    expect(core.setOutput).toHaveBeenCalledWith(
      'attestation-bundle-path',
      '/work/evidence/attestations'
    )
    expect(core.setOutput).not.toHaveBeenCalledWith(
      'attestation-url',
      expect.anything()
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'evidence-manifest-path',
      '/work/evidence/evidence-manifest.json'
    )
  })

  it('passes disk-path through to verification and metadata through to signing', async () => {
    parseSignOnlyInputs.mockReturnValue({
      ...inputs(),
      diskPath: 'disk.qcow2'
    })
    const withMetadata = handoff()
    withMetadata.manifest.artifacts.metadata = {
      path: 'incus.tar.xz',
      sha256: '9'.repeat(64)
    }
    verifyEvidenceManifest.mockResolvedValue(withMetadata)

    await run()

    expect(verifyEvidenceManifest).toHaveBeenCalledWith(
      '/work/evidence/evidence-manifest.json',
      { diskPath: 'disk.qcow2' }
    )
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { path: 'incus.tar.xz', sha256: '9'.repeat(64) }
      })
    )
    const written = writeEvidenceManifest.mock.calls[0][0] as {
      artifacts: object
    }
    expect(written.artifacts).toEqual({
      disk: { path: 'disk.qcow2', sha256: DISK_SHA },
      metadata: { path: 'incus.tar.xz', sha256: '9'.repeat(64) }
    })
  })

  it('records and outputs the attestation URL when the backend returns one', async () => {
    sign.mockResolvedValue({
      ...signResult(),
      attestationUrl: 'https://github.com/o/r/attestations/1'
    })

    await run()

    const written = writeEvidenceManifest.mock.calls[0][0] as {
      attestationUrl?: string
    }
    expect(written.attestationUrl).toBe('https://github.com/o/r/attestations/1')
    expect(core.setOutput).toHaveBeenCalledWith(
      'attestation-url',
      'https://github.com/o/r/attestations/1'
    )
  })

  it('fails without touching the manifest when verification rejects', async () => {
    verifyEvidenceManifest.mockRejectedValue(
      new Error('does not match its recorded digest')
    )

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'does not match its recorded digest'
    )
    expect(sign).not.toHaveBeenCalled()
    expect(writeEvidenceManifest).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
  })

  it('fails without touching the manifest when signing throws', async () => {
    sign.mockRejectedValue(new Error('cosign exploded'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('cosign exploded')
    expect(writeEvidenceManifest).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  it('removes the temp manifest when promotion fails', async () => {
    writeEvidenceManifest.mockRejectedValue(new Error('disk full'))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('disk full')
    expect(rm).toHaveBeenCalledWith('/work/evidence/.evidence-manifest.tmp', {
      force: true
    })
    expect(core.setOutput).not.toHaveBeenCalled()
  })

  it('reports an internal error if no signer comes back', async () => {
    selectSigner.mockReturnValue(null)

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'internal error: sign-only selected no signing backend.'
    )
    expect(writeEvidenceManifest).not.toHaveBeenCalled()
  })
})
