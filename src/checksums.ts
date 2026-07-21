import * as fs from 'node:fs'
import { sha256File } from './hash.js'

/** Inputs for {@link writeChecksums}. */
export interface ChecksumsInput {
  /** Path to the input disk image (digested first, as the re-digest guard). */
  diskPath: string
  /** The disk SHA-256 recorded in stage 2, compared against the re-digest. */
  expectedDiskSha256: string
  /**
   * Optional extra input files (Incus metadata tarball, build manifest) to
   * cover, in the order they should appear after the disk line.
   */
  extraInputs: string[]
  /**
   * Unsigned evidence files to cover (SBOM, vulnerability report, validation
   * report, validation predicate). Attestation bundles are deliberately
   * excluded — they are written after this stage and carry their own
   * verification material.
   */
  evidenceFiles: string[]
  /** Path the `checksums.txt` file is written to. */
  outputPath: string
}

// One `sha256sum -c`-compatible line: lowercase hex, two spaces, then the path
// exactly as the caller passed it (workspace-relative). The two-space separator
// is what GNU coreutils writes for a "binary" digest and requires on read-back.
function line(hex: string, filePath: string): string {
  return `${hex}  ${filePath}`
}

/**
 * Write a `sha256sum -c`-compatible `checksums.txt` covering the input disk,
 * optional extra inputs, and every unsigned evidence file.
 *
 * The input disk is re-digested **first**; if the digest differs from
 * `expectedDiskSha256` (the stage-2 value), the run's read-only guarantee was
 * violated and the function throws before writing anything, turning any
 * accidental modification into a hard failure. Paths are written exactly as
 * passed, so a later `sha256sum -c checksums.txt` from the same working
 * directory verifies them.
 */
export async function writeChecksums(input: ChecksumsInput): Promise<void> {
  const actual = await sha256File(input.diskPath)
  if (actual !== input.expectedDiskSha256) {
    throw new Error(
      `The input disk "${input.diskPath}" changed during the run: ` +
        `expected sha256 ${input.expectedDiskSha256}, re-digested ${actual}. ` +
        'The image must never be modified; refusing to seal checksums.'
    )
  }

  const lines: string[] = [line(actual, input.diskPath)]

  for (const extra of input.extraInputs) {
    lines.push(line(await sha256File(extra), extra))
  }
  for (const evidence of input.evidenceFiles) {
    lines.push(line(await sha256File(evidence), evidence))
  }

  await fs.promises.writeFile(input.outputPath, lines.join('\n') + '\n')
}
