import * as fs from 'node:fs'
import { sha256File } from './hash.js'

/** Stable roles assigned to files in the evidence handoff contract. */
export type EvidenceRole =
  | 'checksums'
  | 'sbom'
  | 'vulnerability-report'
  | 'validation-report'
  | 'validation-predicate'
  | 'provenance-attestation'
  | 'sbom-attestation'
  | 'validation-attestation'

/** Media types emitted by version 1 of the evidence manifest. */
export const EVIDENCE_MEDIA_TYPES = {
  checksums: 'text/plain',
  spdx: 'application/spdx+json',
  cyclonedx: 'application/vnd.cyclonedx+json',
  json: 'application/json',
  inToto: 'application/vnd.in-toto+json',
  sigstoreBundle: 'application/vnd.dev.sigstore.bundle.v0.3+json'
} as const

export type EvidenceMediaType =
  (typeof EVIDENCE_MEDIA_TYPES)[keyof typeof EVIDENCE_MEDIA_TYPES]

/** A caller-known evidence file that will be hashed into the manifest. */
export interface EvidenceSource {
  role: EvidenceRole
  path: string
  mediaType: EvidenceMediaType
}

/** An input artifact paired with its already-verified digest. */
export interface ManifestArtifact {
  path: string
  sha256: string
}

/** One evidence entry after hashing the actual file bytes. */
export interface ManifestEvidence extends EvidenceSource {
  sha256: string
}

/** Version 1 of the downstream evidence handoff document. */
export interface EvidenceManifest {
  schemaVersion: '1'
  result: 'pass' | 'fail'
  artifacts: {
    disk: ManifestArtifact
    metadata: ManifestArtifact | null
    buildManifest: ManifestArtifact | null
  }
  evidence: ManifestEvidence[]
  attestationUrl?: string
}

/** Everything needed to write one complete evidence manifest. */
export interface EvidenceManifestInput {
  outputPath: string
  result: EvidenceManifest['result']
  artifacts: {
    disk: ManifestArtifact
    metadata?: ManifestArtifact
    buildManifest?: ManifestArtifact
  }
  evidence: EvidenceSource[]
  attestationUrl?: string
}

/**
 * Hash each explicitly supplied evidence file and write a deterministic,
 * versioned handoff document. The manifest is intentionally not eligible as an
 * `evidence` source: the caller builds that fixed list before this file exists.
 */
export async function writeEvidenceManifest(
  input: EvidenceManifestInput
): Promise<EvidenceManifest> {
  const evidence: ManifestEvidence[] = []
  for (const source of input.evidence) {
    evidence.push({
      role: source.role,
      path: source.path,
      sha256: await sha256File(source.path),
      mediaType: source.mediaType
    })
  }

  const manifest: EvidenceManifest = {
    schemaVersion: '1',
    result: input.result,
    artifacts: {
      disk: input.artifacts.disk,
      metadata: input.artifacts.metadata ?? null,
      buildManifest: input.artifacts.buildManifest ?? null
    },
    evidence,
    ...(input.attestationUrl === undefined
      ? {}
      : { attestationUrl: input.attestationUrl })
  }

  await fs.promises.writeFile(
    input.outputPath,
    JSON.stringify(manifest, null, 2)
  )
  return manifest
}
