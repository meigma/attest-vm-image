import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DiskInfo } from './disk.js'
import type { FsView, OperatingSystem } from './inspect.js'
import type { MetadataInfo } from './metadata.js'
import type { SbomResult } from './sbom.js'
import type { VulnResult, VulnSummary } from './vuln.js'
import type {
  ContaminationResult,
  Check,
  PolicyIdentity
} from './contamination.js'
import type { ToolVersion } from './tools.js'
import type { WorkflowContext } from './context.js'
import type { FailOnSeverity } from './inputs.js'

/**
 * The in-toto Statement type all statements this action emits carry as `_type`.
 */
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1'

/**
 * This action's own predicate type: a project-owned, versioned, opaque
 * identifier. It is not a live endpoint; the schema is documented in-repo under
 * `docs/docs/predicate/`, and
 * `docs/docs/predicate/vm-image-validation-v1.schema.json`
 * carries this exact string as its `$id` (asserted by a unit test).
 */
export const PREDICATE_TYPE =
  'https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1'

/** The digest-only metadata field carried by the predicate. */
export interface MetadataDigest {
  sha256: string
}

/** Optional build-manifest digest, computed in `main.ts` right after stage 1. */
export interface BuildManifestInfo {
  sha256: string
}

/**
 * The shared pipeline state the predicate assembler reads. Every field is
 * produced by exactly one earlier stage and only read here (see design's "Where
 * each field comes from"). Optional fields are absent when their input was not
 * provided.
 */
export interface PredicateState {
  /** The `disk-path` input, used for the subject/artifact name. */
  diskPath: string
  /** Stage 2 disk facts. */
  disk: DiskInfo
  /** Stage 4 metadata, when `metadata-path` was provided. */
  metadata?: MetadataInfo
  /** Build-manifest digest, when `build-manifest-path` was provided. */
  buildManifest?: BuildManifestInfo
  /** Resolved tool name/version pairs (`toolVersions()`). */
  tools: ToolVersion[]
  /** Stage 3 filesystem view. */
  fsView: FsView
  /** Stage 5 SBOM result. */
  sbom: SbomResult
  /** Stage 6 vulnerability result. */
  vuln: VulnResult
  /** Stage 7 contamination result. */
  contamination: ContaminationResult
  /** The `fail-on-severity` threshold in effect. */
  threshold: FailOnSeverity
  /** Captured workflow context. */
  workflow: WorkflowContext
}

/** The `vulnerabilities` block of the predicate (scanner flattened to a name). */
export interface PredicateVulnerabilities {
  scanner: string
  dbVersion: string
  sha256: string
  summary: VulnSummary
  threshold: FailOnSeverity
  thresholdExceeded: boolean
}

/** The validation predicate payload. */
export interface ValidationPredicate {
  schemaVersion: '1'
  artifact: { name: string; sizeBytes: number; sha256: string }
  incusMetadata: MetadataDigest | null
  buildManifest: BuildManifestInfo | null
  tools: ToolVersion[]
  operatingSystem: OperatingSystem
  sbom: { format: string; sha256: string }
  vulnerabilities: PredicateVulnerabilities
  checks: Check[]
  policy: PolicyIdentity
  result: 'pass' | 'fail'
  workflow: WorkflowContext
}

/** An in-toto statement subject: a named artifact and its digest set. */
export interface StatementSubject {
  name: string
  digest: { sha256: string }
}

/** The full in-toto statement wrapping the validation predicate. */
export interface Statement {
  _type: typeof STATEMENT_TYPE
  subject: StatementSubject[]
  predicateType: typeof PREDICATE_TYPE
  predicate: ValidationPredicate
}

/**
 * Compute the overall `result`: `fail` when any contamination check failed or
 * the vulnerability threshold was exceeded; otherwise `pass`. (An invalid
 * metadata archive is a fail-closed abort in stage 4 and never reaches here.)
 */
function computeResult(state: PredicateState): 'pass' | 'fail' {
  const anyCheckFailed = state.contamination.checks.some(
    (check) => check.status === 'fail'
  )
  if (anyCheckFailed || state.vuln.thresholdExceeded) return 'fail'
  return 'pass'
}

/**
 * Assemble the in-toto statement (subject = the disk basename + its SHA-256) and
 * the validation predicate from the shared `state`. Every digest and property is
 * read straight off `state`; nothing is recomputed here. `incusMetadata` and
 * `buildManifest` are `null` when their inputs were absent, and the predicate's
 * `policy` carries a `sha256` only when a custom `policy-path` was used (that is
 * exactly what `state.contamination.policy` records).
 */
export function buildStatement(state: PredicateState): Statement {
  const artifactName = path.basename(state.diskPath)

  const predicate: ValidationPredicate = {
    schemaVersion: '1',
    artifact: {
      name: artifactName,
      sizeBytes: state.disk.sizeBytes,
      sha256: state.disk.sha256
    },
    incusMetadata: state.metadata ? { sha256: state.metadata.sha256 } : null,
    buildManifest: state.buildManifest
      ? { sha256: state.buildManifest.sha256 }
      : null,
    tools: state.tools,
    operatingSystem: state.fsView.operatingSystem,
    sbom: { format: state.sbom.format, sha256: state.sbom.sha256 },
    vulnerabilities: {
      scanner: state.vuln.scanner.name,
      dbVersion: state.vuln.dbVersion,
      sha256: state.vuln.sha256,
      summary: state.vuln.summary,
      threshold: state.threshold,
      thresholdExceeded: state.vuln.thresholdExceeded
    },
    checks: state.contamination.checks,
    policy: state.contamination.policy,
    result: computeResult(state),
    workflow: state.workflow
  }

  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: artifactName, digest: { sha256: state.disk.sha256 } }],
    predicateType: PREDICATE_TYPE,
    predicate
  }
}

/** Destination paths for the two evidence documents this stage writes. */
export interface EvidencePaths {
  predicatePath: string
  reportPath: string
}

/**
 * The human/machine-readable report: the predicate flattened, plus the raw Incus
 * `properties` object folded into `incusMetadata` (properties live only in the
 * report, never the digest-only predicate). The subject/predicate-type header is
 * carried too so a reader has the same anchors as the statement.
 */
export interface ValidationReport extends Omit<
  ValidationPredicate,
  'incusMetadata'
> {
  subject: StatementSubject[]
  predicateType: typeof PREDICATE_TYPE
  incusMetadata:
    (MetadataDigest & { properties: Record<string, unknown> }) | null
}

/**
 * Build the flattened validation report from a statement and the source state.
 * The only field the report carries that the predicate does not is
 * `incusMetadata.properties`.
 */
export function buildReport(
  statement: Statement,
  state: PredicateState
): ValidationReport {
  return {
    subject: statement.subject,
    predicateType: statement.predicateType,
    // Spread the predicate, then override `incusMetadata` so the report's
    // richer (digest + properties) value wins over the digest-only field.
    ...statement.predicate,
    incusMetadata: state.metadata
      ? { sha256: state.metadata.sha256, properties: state.metadata.properties }
      : null
  }
}

/**
 * Assemble and write both evidence documents: `validation-predicate.json` (the
 * in-toto statement) and `validation-report.json` (the flattened report that
 * additionally carries `incusMetadata.properties`). Returns the built statement
 * so the orchestrator can read the overall `result` and decide whether to sign
 * or fail.
 */
export async function writeEvidence(
  state: PredicateState,
  paths: EvidencePaths
): Promise<Statement> {
  const statement = buildStatement(state)
  const report = buildReport(statement, state)

  await fs.promises.writeFile(
    paths.predicatePath,
    JSON.stringify(statement, null, 2)
  )
  await fs.promises.writeFile(paths.reportPath, JSON.stringify(report, null, 2))

  return statement
}
