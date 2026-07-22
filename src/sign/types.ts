import type { SbomFormat } from '../inputs.js'
import type { Statement } from '../predicate.js'

/** A file reference paired with its precomputed lowercase-hex SHA-256 digest. */
export interface SignArtifact {
  /** Path to the file on disk. */
  path: string
  /** Lowercase-hex SHA-256 of the file. */
  sha256: string
}

/**
 * Everything a signing backend needs to produce the three attestations. Every
 * digest here was computed by an earlier stage; a signer never re-hashes.
 */
export interface SignContext {
  /** The input QCOW2 disk: the subject of every attestation. */
  disk: SignArtifact
  /** The Incus metadata tarball, an extra provenance subject when present. */
  metadata?: SignArtifact
  /** The generated SBOM: path, format, and digest. */
  sbom: SignArtifact & { format: SbomFormat }
  /** The in-toto statement whose predicate drives the validation attestation. */
  statement: Statement
  /** The evidence output directory; bundles are written under `attestations/`. */
  outputDir: string
}

/** A signed bundle written by a completed signing backend. */
export interface SignBundle {
  role: 'provenance-attestation' | 'sbom-attestation' | 'validation-attestation'
  path: string
}

/** What a completed signing run reports back to the orchestrator. */
export interface SignResult {
  /** Directory holding the three `*.sigstore.json` bundles. */
  bundleDir: string
  /** The exact signed bundle files produced, in stable role order. */
  bundles: SignBundle[]
  /** URL of the validation attestation, when the backend publishes one. */
  attestationUrl?: string
}

/** A signing backend: turns a `SignContext` into signed, published evidence. */
export interface Signer {
  sign(ctx: SignContext): Promise<SignResult>
}
