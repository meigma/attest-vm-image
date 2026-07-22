/**
 * Unit tests for src/sign/index.ts and src/sign/github.ts.
 *
 * `@actions/attest` is fully mocked — no test ever performs real signing or
 * touches the network. `@actions/core` uses the shared fixture. node:fs is REAL:
 * the SBOM predicate is read from, and bundles are written into, a real temp
 * directory, so the on-disk layout is asserted against actual files.
 */
import { jest } from '@jest/globals'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'
import { PREDICATE_TYPE } from '../src/predicate.js'
import type { Statement } from '../src/predicate.js'
import type { Inputs, Signer as SignerName } from '../src/inputs.js'
import type {
  AttestOptions,
  AttestProvenanceOptions,
  Attestation
} from '@actions/attest'

const attest = jest.fn<(o: AttestOptions) => Promise<Attestation>>()
const attestProvenance =
  jest.fn<(o: AttestProvenanceOptions) => Promise<Attestation>>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/attest', () => ({
  attest,
  attestProvenance
}))

const { selectSigner } = await import('../src/sign/index.js')
const { GithubSigner } = await import('../src/sign/github.js')
const { CosignKeySigner, KmsSigner, SigstoreKeylessSigner } =
  await import('../src/sign/cosign.js')

// A minimal fake bundle/attestation the mocked library returns.
const fakeAttestation = (id: string): Attestation =>
  ({
    bundle: { mediaType: 'sigstore-bundle', fake: id },
    certificate: `CERT-${id}`,
    tlogID: `tlog-${id}`,
    attestationID: id
  }) as unknown as Attestation

const REPO = 'meigma/attest-vm-image'
const FAKE_TOKEN = 'ghs_faketoken'
const DISK_SHA = 'a'.repeat(64)
const META_SHA = 'b'.repeat(64)
const SBOM_SHA = 'd'.repeat(64)

const inputsWith = (signer: SignerName): Inputs => ({
  diskPath: 'disk.qcow2',
  outputDirectory: './evidence',
  sbomFormat: 'spdx-json',
  failOnSeverity: 'high',
  signer,
  githubToken: FAKE_TOKEN,
  ...(signer === 'cosign-key'
    ? { signingKey: 'cosign.key' }
    : signer === 'kms'
      ? {
          signingKey:
            'awskms:///arn:aws:kms:us-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab'
        }
      : {})
})

const statement = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{ name: 'disk.qcow2', digest: { sha256: DISK_SHA } }],
  predicateType: PREDICATE_TYPE,
  predicate: { schemaVersion: '1', result: 'pass', tag: 'validation-payload' }
} as unknown as Statement

describe('selectSigner', () => {
  it('returns null for "none"', () => {
    expect(selectSigner(inputsWith('none'))).toBeNull()
  })

  it('returns a GithubSigner for "github"', () => {
    expect(selectSigner(inputsWith('github'))).toBeInstanceOf(GithubSigner)
  })

  it('returns a CosignKeySigner for "cosign-key"', () => {
    expect(selectSigner(inputsWith('cosign-key'))).toBeInstanceOf(
      CosignKeySigner
    )
  })

  it('returns a SigstoreKeylessSigner for "sigstore-keyless"', () => {
    process.env.GITHUB_SERVER_URL = 'https://github.com'
    process.env.GITHUB_WORKFLOW_REF =
      'meigma/attest-vm-image/.github/workflows/integration.yml@refs/heads/test'
    expect(selectSigner(inputsWith('sigstore-keyless'))).toBeInstanceOf(
      SigstoreKeylessSigner
    )
    delete process.env.GITHUB_SERVER_URL
    delete process.env.GITHUB_WORKFLOW_REF
  })

  it('returns a KmsSigner for "kms"', () => {
    expect(selectSigner(inputsWith('kms'))).toBeInstanceOf(KmsSigner)
  })
})

describe('GithubSigner.sign', () => {
  let dir: string
  let sbomPath: string
  const sbomDoc = { spdxVersion: 'SPDX-2.3', name: 'test-sbom' }

  const baseCtx = () => ({
    disk: { path: join(dir, 'disk.qcow2'), sha256: DISK_SHA },
    metadata: undefined,
    sbom: {
      path: sbomPath,
      format: 'spdx-json' as const,
      sha256: SBOM_SHA
    },
    statement,
    outputDir: dir
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-sign-'))
    sbomPath = join(dir, 'sbom.spdx.json')
    writeFileSync(sbomPath, JSON.stringify(sbomDoc))
    process.env.GITHUB_REPOSITORY = REPO
    attestProvenance.mockResolvedValue(fakeAttestation('prov-id'))
    attest
      .mockResolvedValueOnce(fakeAttestation('sbom-id'))
      .mockResolvedValueOnce(fakeAttestation('val-id'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    jest.clearAllMocks()
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_SERVER_URL
  })

  it('calls attestProvenance once and attest twice with the right subjects, types, and predicates', async () => {
    const result = await new GithubSigner(FAKE_TOKEN).sign(baseCtx())

    // Provenance: one call, disk subject only (no metadata here), token passed.
    expect(attestProvenance).toHaveBeenCalledTimes(1)
    const prov = attestProvenance.mock.calls[0][0]
    expect(prov.subjects).toEqual([
      { name: 'disk.qcow2', digest: { sha256: DISK_SHA } }
    ])
    expect(prov.token).toBe('ghs_faketoken')

    // Two attest calls: SBOM then validation.
    expect(attest).toHaveBeenCalledTimes(2)

    const sbomCall = attest.mock.calls[0][0]
    expect(sbomCall.predicateType).toBe('https://spdx.dev/Document/v2.3')
    expect(sbomCall.predicate).toEqual(sbomDoc)
    expect(sbomCall.subjects).toEqual([
      { name: 'disk.qcow2', digest: { sha256: DISK_SHA } }
    ])

    // The validation attest call carries PREDICATE_TYPE and the predicate
    // payload (the statement's predicate, not the whole statement).
    const valCall = attest.mock.calls[1][0]
    expect(valCall.predicateType).toBe(PREDICATE_TYPE)
    expect(valCall.predicate).toEqual(statement.predicate)
    expect(valCall.subjects).toEqual([
      { name: 'disk.qcow2', digest: { sha256: DISK_SHA } }
    ])

    // attestationUrl is derived from the VALIDATION attestation's ID.
    expect(result.attestationUrl).toBe(
      `https://github.com/${REPO}/attestations/val-id`
    )
    expect(result.bundleDir).toBe(join(dir, 'attestations'))
    expect(result.bundles).toEqual([
      {
        role: 'provenance-attestation',
        path: join(dir, 'attestations', 'provenance.sigstore.json')
      },
      {
        role: 'sbom-attestation',
        path: join(dir, 'attestations', 'sbom.sigstore.json')
      },
      {
        role: 'validation-attestation',
        path: join(dir, 'attestations', 'validation.sigstore.json')
      }
    ])
  })

  it('writes the three bundles to attestations/{provenance,sbom,validation}.sigstore.json', async () => {
    await new GithubSigner(FAKE_TOKEN).sign(baseCtx())

    const bundles = join(dir, 'attestations')
    for (const [name, id] of [
      ['provenance.sigstore.json', 'prov-id'],
      ['sbom.sigstore.json', 'sbom-id'],
      ['validation.sigstore.json', 'val-id']
    ] as const) {
      const p = join(bundles, name)
      expect(existsSync(p)).toBe(true)
      // The file is the returned Sigstore bundle, not the whole Attestation.
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({
        mediaType: 'sigstore-bundle',
        fake: id
      })
    }
  })

  it('adds the metadata artifact as a second provenance subject when present', async () => {
    const ctx = {
      ...baseCtx(),
      metadata: { path: join(dir, 'metadata.tar.gz'), sha256: META_SHA }
    }
    await new GithubSigner(FAKE_TOKEN).sign(ctx)

    const prov = attestProvenance.mock.calls[0][0]
    expect(prov.subjects).toEqual([
      { name: 'disk.qcow2', digest: { sha256: DISK_SHA } },
      { name: 'metadata.tar.gz', digest: { sha256: META_SHA } }
    ])
    // The SBOM and validation attestations still carry only the disk subject.
    expect(attest.mock.calls[0][0].subjects).toHaveLength(1)
    expect(attest.mock.calls[1][0].subjects).toHaveLength(1)
  })

  it('derives the SPDX predicate type from the document spdxVersion', async () => {
    writeFileSync(
      sbomPath,
      JSON.stringify({ spdxVersion: 'SPDX-2.4', name: 'test-sbom' })
    )
    await new GithubSigner(FAKE_TOKEN).sign(baseCtx())

    expect(attest.mock.calls[0][0].predicateType).toBe(
      'https://spdx.dev/Document/v2.4'
    )
  })

  it('falls back to SPDX v2.3 when the document omits spdxVersion', async () => {
    writeFileSync(sbomPath, JSON.stringify({ name: 'no-version' }))
    await new GithubSigner(FAKE_TOKEN).sign(baseCtx())

    expect(attest.mock.calls[0][0].predicateType).toBe(
      'https://spdx.dev/Document/v2.3'
    )
  })

  it('uses the version-independent CycloneDX predicate type', async () => {
    writeFileSync(
      sbomPath,
      JSON.stringify({ specVersion: '1.6', bomFormat: 'CycloneDX' })
    )
    const ctx = {
      ...baseCtx(),
      sbom: {
        path: sbomPath,
        format: 'cyclonedx-json' as const,
        sha256: SBOM_SHA
      }
    }
    await new GithubSigner(FAKE_TOKEN).sign(ctx)

    expect(attest.mock.calls[0][0].predicateType).toBe(
      'https://cyclonedx.org/bom'
    )
  })

  it('derives the attestation URL host from GITHUB_SERVER_URL', async () => {
    process.env.GITHUB_SERVER_URL = 'https://github.example.ghe.com'
    const result = await new GithubSigner(FAKE_TOKEN).sign(baseCtx())

    expect(result.attestationUrl).toBe(
      `https://github.example.ghe.com/${REPO}/attestations/val-id`
    )
  })

  it('re-throws an unsupported-plan API rejection as the named-capability diagnostic', async () => {
    attestProvenance.mockReset()
    // A realistic octokit-flattened message: store.js stringifies err.message
    // (the API body's `message` plus documentation_url) and discards the numeric
    // status, so classification must key off the text the library actually
    // emits — here "Not Found", not a synthetic "(status 404)".
    attestProvenance.mockRejectedValue(
      new Error(
        'Failed to persist attestation: Not Found - ' +
          'https://docs.github.com/rest/repos/repos#get-a-repository'
      )
    )

    await expect(new GithubSigner(FAKE_TOKEN).sign(baseCtx())).rejects.toThrow(
      /plan cannot issue attestations/
    )
    await expect(new GithubSigner(FAKE_TOKEN).sign(baseCtx())).rejects.toThrow(
      /public repository or GitHub Enterprise Cloud/
    )
  })

  it('propagates an unrelated attest error unchanged (no plan downgrade)', async () => {
    attestProvenance.mockReset()
    attestProvenance.mockRejectedValue(
      new Error('OIDC token request timed out')
    )

    await expect(new GithubSigner(FAKE_TOKEN).sign(baseCtx())).rejects.toThrow(
      /OIDC token request timed out/
    )
  })

  it('does not misclassify a persist error that carries no plan signal', async () => {
    attestProvenance.mockReset()
    // The library prefix is present, but the underlying status is a transient
    // 500, not a plan rejection: it must propagate unchanged.
    attestProvenance.mockRejectedValue(
      new Error('Failed to persist attestation: HttpError: 500 server error')
    )

    const err = await new GithubSigner(FAKE_TOKEN)
      .sign(baseCtx())
      .catch((e) => e)
    expect((err as Error).message).toBe(
      'Failed to persist attestation: HttpError: 500 server error'
    )
    expect((err as Error).message).not.toMatch(/plan cannot issue/)
  })

  it('still returns a well-formed URL when the API omits an attestationID', async () => {
    attest.mockReset()
    attest
      .mockResolvedValueOnce(fakeAttestation('sbom-id'))
      .mockResolvedValueOnce({
        bundle: { mediaType: 'sigstore-bundle', fake: 'noid' },
        certificate: 'CERT'
      } as unknown as Attestation)

    const result = await new GithubSigner(FAKE_TOKEN).sign(baseCtx())
    expect(result.attestationUrl).toBe(
      `https://github.com/${REPO}/attestations/`
    )
  })

  it('throws a clear diagnostic when the github-token is empty', async () => {
    await expect(new GithubSigner('').sign(baseCtx())).rejects.toThrow(
      /github-token/
    )
    expect(attestProvenance).not.toHaveBeenCalled()
  })
})
