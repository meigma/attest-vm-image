import * as fs from 'node:fs'
import * as path from 'node:path'
import * as core from '@actions/core'
import { attest, attestProvenance } from '@actions/attest'
import type { Attestation, Subject } from '@actions/attest'
import { PREDICATE_TYPE } from '../predicate.js'
import type { SbomFormat } from '../inputs.js'
import type { SignContext, SignResult, Signer } from './types.js'

/** Subdirectory (under `output-directory`) that holds the signed bundles. */
const BUNDLE_DIR = 'attestations'
const PROVENANCE_BUNDLE = 'provenance.sigstore.json'
const SBOM_BUNDLE = 'sbom.sigstore.json'
const VALIDATION_BUNDLE = 'validation.sigstore.json'

/** Predicate-type URI for a CycloneDX SBOM document (version-independent). */
const CYCLONEDX_PREDICATE_TYPE = 'https://cyclonedx.org/bom'

/**
 * GitHub-native signing via the `@actions/attest` toolkit library (the same
 * library behind the `actions/attest` action), using GitHub Actions OIDC. It
 * produces three attestations for the disk image — build provenance, an SBOM
 * attestation, and a custom validation attestation — and pushes each to
 * GitHub's attestation API, writing the returned Sigstore bundles into
 * `<output-directory>/attestations/`.
 *
 * The signing identity comes from the workflow's OIDC token (the caller must
 * grant `id-token: write`); the attestation-API push is authenticated with the
 * `github-token` action input, which defaults to the job's `${{ github.token }}`
 * and must carry `attestations: write` (the same pattern the `actions/attest`
 * action uses, rather than assuming an ambient environment variable). Plan
 * support is reactive: an API rejection because the repository's plan cannot
 * issue attestations is re-thrown as a named-capability diagnostic — no
 * pre-probe, no silent downgrade.
 */
export class GithubSigner implements Signer {
  /**
   * @param token GitHub API token used to push attestations (the `github-token`
   *   action input, defaulting to `${{ github.token }}`). Must carry
   *   `attestations: write`.
   */
  constructor(private readonly token: string) {}

  async sign(ctx: SignContext): Promise<SignResult> {
    const token = this.token
    if (!token) {
      throw new Error(
        'signer: github requires a GitHub token to push attestations to the ' +
          'GitHub attestation API. Provide the github-token input (it defaults ' +
          "to the job's ${{ github.token }} and must carry " +
          'attestations: write), but it resolved empty.'
      )
    }

    const bundleDir = path.join(ctx.outputDir, BUNDLE_DIR)
    await fs.promises.mkdir(bundleDir, { recursive: true })

    // The disk is the subject of every attestation; the digest is the value an
    // independent `gh attestation verify` recomputes from the QCOW2 bytes.
    const diskSubject: Subject = {
      name: path.basename(ctx.disk.path),
      digest: { sha256: ctx.disk.sha256 }
    }

    // 1. Build provenance over the disk (plus the metadata artifact when one
    //    was supplied).
    const provenanceSubjects: Subject[] = [diskSubject]
    if (ctx.metadata) {
      provenanceSubjects.push({
        name: path.basename(ctx.metadata.path),
        digest: { sha256: ctx.metadata.sha256 }
      })
    }
    const provenance = await this.attest(() =>
      attestProvenance({ subjects: provenanceSubjects, token })
    )
    await writeBundle(bundleDir, PROVENANCE_BUNDLE, provenance)
    logAttestation('provenance', provenance.attestationID)

    // 2. SBOM attestation over the disk, predicate = the parsed SBOM document.
    const sbomPredicate = JSON.parse(
      await fs.promises.readFile(ctx.sbom.path, 'utf8')
    ) as object
    const sbom = await this.attest(() =>
      attest({
        subjects: [diskSubject],
        predicateType: sbomPredicateType(ctx.sbom.format, sbomPredicate),
        predicate: sbomPredicate,
        token
      })
    )
    await writeBundle(bundleDir, SBOM_BUNDLE, sbom)
    logAttestation('sbom', sbom.attestationID)

    // 3. Custom validation attestation over the disk, predicate = the
    //    validation predicate payload (not the whole statement).
    const validation = await this.attest(() =>
      attest({
        subjects: [diskSubject],
        predicateType: PREDICATE_TYPE,
        predicate: ctx.statement.predicate,
        token
      })
    )
    await writeBundle(bundleDir, VALIDATION_BUNDLE, validation)

    // The validation attestation's URL is the run's primary claim and the one
    // surfaced on the `attestation-url` output.
    const validationUrl = attestationUrl(validation.attestationID)
    core.info(`validation attestation: ${validationUrl}`)

    return {
      bundleDir,
      bundles: [
        {
          role: 'provenance-attestation',
          path: path.join(bundleDir, PROVENANCE_BUNDLE)
        },
        {
          role: 'sbom-attestation',
          path: path.join(bundleDir, SBOM_BUNDLE)
        },
        {
          role: 'validation-attestation',
          path: path.join(bundleDir, VALIDATION_BUNDLE)
        }
      ],
      attestationUrl: validationUrl
    }
  }

  /**
   * Run one `@actions/attest` call, translating an unsupported-plan rejection
   * into a named-capability diagnostic. The library flattens an
   * attestation-API push failure into an `Error` whose message begins
   * `Failed to persist attestation:`; when that flattened message shows the
   * repository plan cannot issue attestations (the 403/404 octokit messages a
   * private or internal repository without Enterprise Cloud, or Enterprise
   * Server, produces), it is re-thrown naming the missing capability. Every
   * other error propagates unchanged — the signer never downgrades to a
   * different backend.
   */
  private async attest(call: () => Promise<Attestation>): Promise<Attestation> {
    try {
      return await call()
    } catch (error) {
      if (isUnsupportedPlanError(error)) {
        throw new Error(
          "this repository's plan cannot issue attestations; signer: github " +
            'requires a public repository or GitHub Enterprise Cloud (GitHub ' +
            'Enterprise Server is unsupported), and the caller must grant ' +
            'permissions id-token: write + attestations: write. Underlying ' +
            `error: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      }
      throw error
    }
  }
}

/** Write an attestation's Sigstore bundle to `<dir>/<name>` as pretty JSON. */
async function writeBundle(
  dir: string,
  name: string,
  attestation: Attestation
): Promise<void> {
  await fs.promises.writeFile(
    path.join(dir, name),
    JSON.stringify(attestation.bundle, null, 2)
  )
}

/**
 * Canonical GitHub URL for a persisted attestation ID. The host is taken from
 * `GITHUB_SERVER_URL` (falling back to `https://github.com`) so the URL tracks
 * the actual server — matching how `@actions/core` and `@actions/attest` derive
 * it — rather than hard-coding github.com and misreporting on a GitHub
 * Enterprise Cloud data-residency tenant with a custom domain.
 */
function attestationUrl(id: string | undefined): string {
  const base = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  return `${base}/${repository}/attestations/${id ?? ''}`
}

/**
 * Predicate-type URI for an SBOM attestation, derived from the parsed document
 * so it tracks the emitted spec version instead of a pinned constant (the
 * approach `actions/attest-sbom` takes). For SPDX the version comes from the
 * document's `spdxVersion` field (e.g. `SPDX-2.3` -> `.../Document/v2.3`),
 * defaulting to `v2.3` when the field is absent or malformed; CycloneDX carries
 * no version in its predicate type.
 */
function sbomPredicateType(format: SbomFormat, doc: object): string {
  if (format === 'cyclonedx-json') return CYCLONEDX_PREDICATE_TYPE
  const raw = (doc as { spdxVersion?: unknown }).spdxVersion
  const match = typeof raw === 'string' ? /^SPDX-(\d+\.\d+)$/.exec(raw) : null
  return `https://spdx.dev/Document/v${match ? match[1] : '2.3'}`
}

/** Log a non-primary attestation's URL to the workflow log. */
function logAttestation(label: string, id: string | undefined): void {
  if (id) core.info(`${label} attestation: ${attestationUrl(id)}`)
}

/**
 * Whether an error from `@actions/attest` indicates the repository plan cannot
 * issue attestations. The library wraps API push failures as
 * `Failed to persist attestation: <underlying octokit message>` and discards
 * the numeric HTTP status in the process, so classification is necessarily
 * text-based: it matches the standard 403/404 octokit messages a plan rejection
 * produces (`Not Found`, `Resource not accessible by integration`, `Forbidden`,
 * `Advanced Security must be enabled`). A persist failure whose message carries
 * none of these signals is treated as unrelated and propagated unchanged.
 */
function isUnsupportedPlanError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message
  if (!/Failed to persist attestation/i.test(message)) return false
  return /forbidden|not found|not accessible|advanced security/i.test(message)
}
