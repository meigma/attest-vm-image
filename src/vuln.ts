import * as fs from 'node:fs'
import * as path from 'node:path'
import { exec } from './exec.js'
import { sha256File } from './hash.js'
import { ensureBinary } from './tools.js'
import type { FailOnSeverity } from './inputs.js'

/** Per-severity finding counts, the keys used across the predicate. */
export interface VulnSummary {
  critical: number
  high: number
  medium: number
  low: number
  negligible: number
  unknown: number
}

/** The scanner's own name and version, from the Grype report descriptor. */
export interface VulnScanner {
  name: string
  version: string
}

/** Result of a completed vulnerability scan. */
export interface VulnResult {
  /** Path to the written vulnerability report. */
  path: string
  /** SHA-256 of the written report. */
  sha256: string
  /** Scanner identity (`grype` and its version). */
  scanner: VulnScanner
  /** A defensive rendering of the vulnerability database schema/build. */
  dbVersion: string
  /** Per-severity finding counts. */
  summary: VulnSummary
  /** True when any finding at or above the threshold is present. */
  thresholdExceeded: boolean
}

// Minimal shape of a Grype JSON report, restricted to fields this stage reads.
interface GrypeMatch {
  vulnerability?: { id?: string; severity?: string }
}
interface GrypeDocument {
  matches?: GrypeMatch[]
  descriptor?: { name?: string; version?: string; db?: unknown }
}

const KNOWN_SEVERITIES: ReadonlyArray<keyof VulnSummary> = [
  'critical',
  'high',
  'medium',
  'low',
  'negligible'
]

/**
 * The set of severities that a threshold treats as a breach: `critical` covers
 * only critical; `high` covers critical and high; `none` covers nothing
 * (report-only). Exported so the comparator is unit-testable in isolation.
 */
export function severityAtOrAbove(
  threshold: FailOnSeverity
): Array<keyof VulnSummary> {
  if (threshold === 'critical') return ['critical']
  if (threshold === 'high') return ['critical', 'high']
  return []
}

// Tally matches into per-severity counts, case-insensitively; any severity
// outside the known set (including an empty or missing value) counts as unknown.
function summarize(matches: GrypeMatch[]): VulnSummary {
  const summary: VulnSummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    negligible: 0,
    unknown: 0
  }
  for (const match of matches) {
    const severity = String(match.vulnerability?.severity ?? '').toLowerCase()
    const known = KNOWN_SEVERITIES.find((key) => key === severity)
    if (known) summary[known] += 1
    else summary.unknown += 1
  }
  return summary
}

// Render the Grype DB descriptor into a compact version string, defensively:
// the `db` object is flat in some Grype versions and nested under `status` in
// others, and may be absent entirely.
function extractDbVersion(db: unknown): string {
  const record = (db ?? {}) as Record<string, unknown>
  const status = (record.status ?? {}) as Record<string, unknown>
  const schema = record.schemaVersion ?? status.schemaVersion
  const built = record.built ?? status.built

  const parts: string[] = []
  if (schema != null) parts.push(`schema ${String(schema)}`)
  if (built != null) parts.push(`built ${String(built)}`)
  return parts.length > 0 ? parts.join(', ') : 'unknown'
}

/**
 * Scan an SBOM for known vulnerabilities with Grype and evaluate it against the
 * severity threshold.
 *
 * A crash, non-zero exit, empty output, or unparseable JSON is a **scan error**:
 * the function throws with a distinct message and writes no report. A clean scan
 * writes the Grype JSON report to `outputPath`, records scanner and DB
 * information, tallies per-severity counts, and returns `thresholdExceeded` —
 * which is never a throw here, so a threshold breach can be recorded in the
 * predicate before the action fails. `cacheDir`, when supplied, is passed to
 * Grype as `GRYPE_DB_CACHE_DIR` so the vulnerability database can be pre-seeded.
 */
export async function scanVulnerabilities(
  sbomPath: string,
  threshold: FailOnSeverity,
  outputPath: string,
  cacheDir?: string
): Promise<VulnResult> {
  const dir = await ensureBinary('grype')
  const grype = path.join(dir, 'grype')

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>)
  }
  if (cacheDir) env.GRYPE_DB_CACHE_DIR = cacheDir

  const result = await exec(grype, [`sbom:${sbomPath}`, '-o', 'json'], {
    env,
    ignoreReturnCode: true
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Grype vulnerability scan failed (exit code ${result.exitCode}) for ` +
        `"${sbomPath}"; recording no vulnerability verdict.` +
        (result.stderr.trim() ? `\n${result.stderr.trim()}` : '')
    )
  }
  if (result.stdout.trim() === '') {
    throw new Error(
      `Grype produced no output scanning "${sbomPath}"; recording no ` +
        'vulnerability verdict.'
    )
  }

  let doc: GrypeDocument
  try {
    doc = JSON.parse(result.stdout) as GrypeDocument
  } catch {
    throw new Error(
      `Grype produced unparseable output scanning "${sbomPath}"; recording no ` +
        'vulnerability verdict.'
    )
  }

  const summary = summarize(doc.matches ?? [])
  const thresholdExceeded = severityAtOrAbove(threshold).some(
    (key) => summary[key] > 0
  )

  await fs.promises.writeFile(outputPath, result.stdout)

  return {
    path: outputPath,
    sha256: await sha256File(outputPath),
    scanner: {
      name: doc.descriptor?.name ?? '',
      version: doc.descriptor?.version ?? ''
    },
    dbVersion: extractDbVersion(doc.descriptor?.db),
    summary,
    thresholdExceeded
  }
}
