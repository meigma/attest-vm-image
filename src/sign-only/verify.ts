import * as fs from 'node:fs'
import * as path from 'node:path'
import { sha256File } from '../hash.js'
import { EVIDENCE_MEDIA_TYPES } from '../manifest.js'
import type { EvidenceManifest, ManifestEvidence } from '../manifest.js'
import { PREDICATE_TYPE, STATEMENT_TYPE } from '../predicate.js'
import type { Statement } from '../predicate.js'
import type { SbomFormat } from '../inputs.js'

/**
 * The evidence roles a signable manifest must carry, exactly once each, in the
 * order the main action writes them. Attestation roles must be absent: signing
 * an already-signed manifest is refused rather than merged or overwritten.
 */
export const SIGNABLE_ROLES = [
  'checksums',
  'sbom',
  'vulnerability-report',
  'validation-report',
  'validation-predicate'
] as const

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * A fully re-verified evidence handoff, ready to sign. Every path has been
 * re-resolved against the manifest's own directory and every digest re-computed
 * from the actual file bytes, so the caller can hand these values to a signing
 * backend without trusting anything but the bytes on disk.
 */
export interface VerifiedHandoff {
  /** The parsed manifest exactly as read (recorded paths untouched). */
  manifest: EvidenceManifest
  /** Directory containing the manifest; evidence resolves relative to it. */
  manifestDir: string
  /** The five core evidence entries with locally-resolved, verified paths. */
  evidence: ManifestEvidence[]
  /** The verified SBOM: local path, digest, and format from its media type. */
  sbom: { path: string; sha256: string; format: SbomFormat }
  /** The in-toto validation statement parsed from `validation-predicate`. */
  statement: Statement
}

/** Options for {@link verifyEvidenceManifest}. */
export interface VerifyOptions {
  /**
   * When set, the disk at this path is re-hashed and must match the manifest's
   * recorded disk digest. Optional because signing needs only digests — the
   * disk bytes never cross the job boundary unless the caller wants this extra
   * check.
   */
  diskPath?: string
}

/**
 * Read an evidence manifest written by the main action and re-verify the whole
 * handoff fail-closed: schema version, a passing result, an unsigned state,
 * exactly the five core evidence roles, and a fresh digest match for every
 * evidence file against the bytes actually on disk. Evidence files are located
 * as `dirname(manifest)/basename(recorded path)` — the main action co-locates
 * them with the manifest under `output-directory` with fixed basenames — so the
 * handoff survives an artifact upload/download that re-roots the directory.
 * Throws an `Error` with a specific, distinct message on the first violation.
 */
export async function verifyEvidenceManifest(
  manifestPath: string,
  options: VerifyOptions = {}
): Promise<VerifiedHandoff> {
  let raw: string
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf8')
  } catch {
    throw new Error(
      `evidence-manifest "${manifestPath}" does not exist or is not readable.`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`evidence-manifest "${manifestPath}" is not valid JSON.`)
  }
  const manifest = assertManifestShape(parsed, manifestPath)

  if (manifest.result !== 'pass') {
    throw new Error(
      `evidence-manifest "${manifestPath}" records result "${manifest.result}"; a failing result is never signed.`
    )
  }
  if (manifest.attestationUrl !== undefined) {
    throw new Error(
      `evidence-manifest "${manifestPath}" already records an attestation URL; re-signing a signed manifest is refused.`
    )
  }

  const roles = manifest.evidence.map((entry) => entry.role)
  if (roles.some((role) => role.endsWith('-attestation'))) {
    throw new Error(
      `evidence-manifest "${manifestPath}" already contains attestation bundles; re-signing a signed manifest is refused.`
    )
  }
  if (
    roles.length !== SIGNABLE_ROLES.length ||
    SIGNABLE_ROLES.some((role, index) => roles[index] !== role)
  ) {
    throw new Error(
      `evidence-manifest "${manifestPath}" must carry exactly the evidence roles ${SIGNABLE_ROLES.join(
        ', '
      )} in order; got ${roles.join(', ') || 'none'}.`
    )
  }

  const manifestDir = path.dirname(manifestPath)
  const seenBasenames = new Set<string>()
  const evidence: ManifestEvidence[] = []
  for (const entry of manifest.evidence) {
    if (!SHA256_HEX.test(entry.sha256)) {
      throw new Error(
        `evidence-manifest "${manifestPath}" records a malformed sha256 for role "${entry.role}".`
      )
    }
    const basename = path.basename(entry.path)
    if (seenBasenames.has(basename)) {
      throw new Error(
        `evidence-manifest "${manifestPath}" records duplicate evidence basename "${basename}".`
      )
    }
    seenBasenames.add(basename)
    const resolved = path.join(manifestDir, basename)
    let actual: string
    try {
      actual = await sha256File(resolved)
    } catch {
      throw new Error(
        `evidence file "${resolved}" (role "${entry.role}") does not exist or is not readable.`
      )
    }
    if (actual !== entry.sha256) {
      throw new Error(
        `evidence file "${resolved}" (role "${entry.role}") does not match its recorded digest; the handoff was modified and is refused.`
      )
    }
    evidence.push({ ...entry, path: resolved })
  }

  const sbomEntry = evidence.find((entry) => entry.role === 'sbom')
  if (!sbomEntry) {
    throw new Error('internal error: verified evidence is missing the SBOM.')
  }
  const sbom = {
    path: sbomEntry.path,
    sha256: sbomEntry.sha256,
    format: sbomFormatFromMediaType(sbomEntry.mediaType, manifestPath)
  }

  const predicateEntry = evidence.find(
    (entry) => entry.role === 'validation-predicate'
  )
  if (!predicateEntry) {
    throw new Error(
      'internal error: verified evidence is missing the validation predicate.'
    )
  }
  const statement = await readStatement(predicateEntry.path, manifest)

  if (options.diskPath) {
    let actual: string
    try {
      actual = await sha256File(options.diskPath)
    } catch {
      throw new Error(
        `disk-path "${options.diskPath}" does not exist or is not readable.`
      )
    }
    if (actual !== manifest.artifacts.disk.sha256) {
      throw new Error(
        `disk-path "${options.diskPath}" does not match the manifest's recorded disk digest; refusing to sign.`
      )
    }
  }

  return { manifest, manifestDir, evidence, sbom, statement }
}

// Structural validation of the parsed manifest document. Only the fields the
// sign-only flow relies on are asserted; unknown extra fields are ignored.
function assertManifestShape(
  parsed: unknown,
  manifestPath: string
): EvidenceManifest {
  const manifest = parsed as EvidenceManifest
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    manifest.schemaVersion !== '1'
  ) {
    throw new Error(
      `evidence-manifest "${manifestPath}" is not a schemaVersion "1" evidence manifest.`
    )
  }
  const disk = manifest.artifacts?.disk
  if (
    typeof disk?.path !== 'string' ||
    typeof disk?.sha256 !== 'string' ||
    !SHA256_HEX.test(disk.sha256)
  ) {
    throw new Error(
      `evidence-manifest "${manifestPath}" is missing a well-formed artifacts.disk entry.`
    )
  }
  const metadata = manifest.artifacts.metadata
  if (
    metadata !== null &&
    (typeof metadata?.path !== 'string' ||
      typeof metadata?.sha256 !== 'string' ||
      !SHA256_HEX.test(metadata.sha256))
  ) {
    throw new Error(
      `evidence-manifest "${manifestPath}" has a malformed artifacts.metadata entry.`
    )
  }
  if (!Array.isArray(manifest.evidence)) {
    throw new Error(
      `evidence-manifest "${manifestPath}" is missing its evidence list.`
    )
  }
  for (const entry of manifest.evidence) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.role !== 'string' ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      typeof entry.mediaType !== 'string'
    ) {
      throw new Error(
        `evidence-manifest "${manifestPath}" has a malformed evidence entry.`
      )
    }
  }
  return manifest
}

// Map a recorded SBOM media type back to the action's SBOM format input.
function sbomFormatFromMediaType(
  mediaType: string,
  manifestPath: string
): SbomFormat {
  if (mediaType === EVIDENCE_MEDIA_TYPES.spdx) return 'spdx-json'
  if (mediaType === EVIDENCE_MEDIA_TYPES.cyclonedx) return 'cyclonedx-json'
  throw new Error(
    `evidence-manifest "${manifestPath}" records unsupported SBOM media type "${mediaType}".`
  )
}

// Parse the digest-verified validation predicate file as the exact in-toto
// statement the main action wrote, and cross-check it against the manifest.
async function readStatement(
  predicatePath: string,
  manifest: EvidenceManifest
): Promise<Statement> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.promises.readFile(predicatePath, 'utf8'))
  } catch {
    throw new Error(
      `validation predicate "${predicatePath}" is not valid JSON.`
    )
  }
  const statement = parsed as Statement
  if (
    typeof statement !== 'object' ||
    statement === null ||
    statement._type !== STATEMENT_TYPE ||
    statement.predicateType !== PREDICATE_TYPE ||
    !Array.isArray(statement.subject) ||
    statement.subject.length === 0
  ) {
    throw new Error(
      `validation predicate "${predicatePath}" is not a "${PREDICATE_TYPE}" in-toto statement.`
    )
  }
  if (statement.subject[0].digest?.sha256 !== manifest.artifacts.disk.sha256) {
    throw new Error(
      `validation predicate "${predicatePath}" subject digest does not match the manifest's recorded disk digest.`
    )
  }
  if (statement.predicate?.result !== 'pass') {
    throw new Error(
      `validation predicate "${predicatePath}" records a non-passing result; a failing result is never signed.`
    )
  }
  return statement
}
