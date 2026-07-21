import * as fs from 'node:fs'
import * as path from 'node:path'
import { exec } from './exec.js'
import { sha256File } from './hash.js'
import { ensureBinary } from './tools.js'
import type { FsView } from './inspect.js'
import type { SbomFormat } from './inputs.js'

/** Result of a generated SBOM, consumed by the predicate assembler. */
export interface SbomResult {
  /** Path to the written SBOM file. */
  path: string
  /** The SBOM format actually produced. */
  format: SbomFormat
  /** SHA-256 of the written file, computed after the subject digest is embedded. */
  sha256: string
}

// Minimal shape of an SPDX 2.3 document, restricted to the fields this stage
// reads or mutates. Syft's directory source cannot stamp an arbitrary subject
// digest, so the described root package is located and a SHA256 checksum entry
// is added to it after generation.
interface SpdxChecksum {
  algorithm: string
  checksumValue: string
}
interface SpdxPackage {
  SPDXID?: string
  checksums?: SpdxChecksum[]
}
interface SpdxRelationship {
  spdxElementId?: string
  relatedSpdxElement?: string
  relationshipType?: string
}
interface SpdxDocument {
  packages?: SpdxPackage[]
  documentDescribes?: string[]
  relationships?: SpdxRelationship[]
}

// Minimal shape of a CycloneDX 1.5/1.6 document. The subject digest is written
// onto `metadata.component.hashes`.
interface CyclonedxHash {
  alg: string
  content: string
}
interface CyclonedxComponent {
  hashes?: CyclonedxHash[]
}
interface CyclonedxDocument {
  components?: unknown[]
  metadata?: { component?: CyclonedxComponent }
}

// Syft emits these exact `-o` format tokens; the mapping is identity but stays
// explicit so a format rename cannot silently pass the wrong flag.
const SYFT_OUTPUT: Record<SbomFormat, string> = {
  'spdx-json': 'spdx-json',
  'cyclonedx-json': 'cyclonedx-json'
}

// Collect the SPDXID of every element the document DESCRIBES, unioning
// `documentDescribes` with any DESCRIBES relationship. Syft's directory source
// emits exactly one such element — the synthetic root package standing in for
// the scanned directory itself — which is not a real software component.
function describedElements(doc: SpdxDocument): Set<string> {
  const described = new Set<string>()
  for (const id of doc.documentDescribes ?? []) described.add(id)
  for (const rel of doc.relationships ?? []) {
    if (rel.relationshipType === 'DESCRIBES' && rel.relatedSpdxElement) {
      described.add(rel.relatedSpdxElement)
    }
  }
  return described
}

// Embed the disk digest as the SPDX subject: locate the element the document
// DESCRIBES (via `documentDescribes` and/or a DESCRIBES relationship) and add a
// SHA256 checksum entry to that package. Throws when no described package is
// found, so a malformed SBOM cannot silently ship without its subject.
function embedSpdxSubject(
  packages: SpdxPackage[],
  described: Set<string>,
  diskSha256: string
): void {
  let embedded = false
  for (const pkg of packages) {
    if (!pkg.SPDXID || !described.has(pkg.SPDXID)) continue
    const entry: SpdxChecksum = {
      algorithm: 'SHA256',
      checksumValue: diskSha256
    }
    if (pkg.checksums) pkg.checksums.push(entry)
    else pkg.checksums = [entry]
    embedded = true
  }

  if (!embedded) {
    throw new Error(
      'Could not embed the disk digest into the SPDX SBOM: no package matched ' +
        'the document DESCRIBES relationship.'
    )
  }
}

// Embed the disk digest as the CycloneDX subject on `metadata.component.hashes`,
// creating the metadata/component objects defensively when Syft omits them.
function embedCyclonedxSubject(
  doc: CyclonedxDocument,
  diskSha256: string
): void {
  const metadata = (doc.metadata ??= {})
  const component = (metadata.component ??= {})
  component.hashes = [{ alg: 'SHA-256', content: diskSha256 }]
}

/**
 * Generate an SBOM for the inspected filesystem view with Syft, embed the input
 * disk's SHA-256 as the SBOM subject, and return the written file's own digest.
 *
 * Syft scans `fsView.mountPath` as a directory source and emits `spdx-json` or
 * `cyclonedx-json` to stdout; `sbom.ts` post-processes the document to insert
 * the subject digest (SPDX: a checksum on the described root package; CycloneDX:
 * a hash on `metadata.component`) **before** the file's own digest is computed,
 * so the returned `sha256` matches the bytes on disk. Fails with distinct
 * messages when Syft exits non-zero or produces zero packages/components.
 */
export async function generateSbom(
  fsView: FsView,
  format: SbomFormat,
  diskSha256: string,
  outputPath: string
): Promise<SbomResult> {
  const dir = await ensureBinary('syft')
  const syft = path.join(dir, 'syft')

  const result = await exec(
    syft,
    ['scan', `dir:${fsView.mountPath}`, '-o', SYFT_OUTPUT[format]],
    { ignoreReturnCode: true }
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `Syft failed to generate an SBOM (exit code ${result.exitCode}) for ` +
        `"${fsView.mountPath}".` +
        (result.stderr.trim() ? `\n${result.stderr.trim()}` : '')
    )
  }

  if (format === 'spdx-json') {
    const doc = JSON.parse(result.stdout) as SpdxDocument
    const packages = doc.packages ?? []
    const described = describedElements(doc)
    // The described root package (Syft's synthetic stand-in for the scanned
    // directory) is not a real software component, so it is excluded before the
    // fail-closed count. A genuinely empty image emits only that root and must
    // still fail here, mirroring the CycloneDX branch's `doc.components` check.
    const realPackages = packages.filter(
      (pkg) => !pkg.SPDXID || !described.has(pkg.SPDXID)
    )
    if (realPackages.length === 0) {
      throw new Error(
        'Syft produced an SBOM with zero packages; refusing to emit an empty ' +
          'component inventory.'
      )
    }
    embedSpdxSubject(packages, described, diskSha256)
    await fs.promises.writeFile(outputPath, JSON.stringify(doc, null, 2))
  } else {
    const doc = JSON.parse(result.stdout) as CyclonedxDocument
    if ((doc.components ?? []).length === 0) {
      throw new Error(
        'Syft produced an SBOM with zero components; refusing to emit an empty ' +
          'component inventory.'
      )
    }
    embedCyclonedxSubject(doc, diskSha256)
    await fs.promises.writeFile(outputPath, JSON.stringify(doc, null, 2))
  }

  return { path: outputPath, format, sha256: await sha256File(outputPath) }
}
