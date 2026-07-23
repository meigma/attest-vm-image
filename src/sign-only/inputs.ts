import * as core from '@actions/core'
import { SIGNERS, validateSigningInputs } from '../inputs.js'
import type { Signer } from '../inputs.js'

/** A signer the sign-only action accepts: every backend except `none`. */
export type SignOnlySigner = Exclude<Signer, 'none'>

/** Parsed, validated sign-only action inputs with defaults applied. */
export interface SignOnlyInputs {
  /** Path to the evidence manifest written by the main action. */
  evidenceManifestPath: string
  /** Optional disk path for the extra digest re-check; usually unset. */
  diskPath?: string
  signer: SignOnlySigner
  signingKey?: string
  githubToken: string
}

/**
 * Read the sign-only action's inputs, apply defaults, and validate them with
 * the exact signer/key rules the main action uses. `signer` is required here
 * (there is no pipeline to run without one) and `none` is rejected: a job that
 * signs nothing should simply not run this action. Throws an `Error` with a
 * specific, distinct message on the first invalid input.
 */
export function parseSignOnlyInputs(): SignOnlyInputs {
  const evidenceManifestPath =
    core.getInput('evidence-manifest') || './evidence/evidence-manifest.json'

  const signerInput = core.getInput('signer')
  if (!signerInput) {
    throw new Error('signer is required but was not provided.')
  }
  const backends = SIGNERS.filter((name) => name !== 'none')
  if (signerInput === 'none') {
    throw new Error(
      'signer "none" is not valid for the sign action; select one of ' +
        `${backends.join(', ')}, or omit this step entirely.`
    )
  }
  if (!backends.includes(signerInput as Signer)) {
    throw new Error(
      `signer must be one of ${backends.join(', ')}; got "${signerInput}".`
    )
  }
  const signer = signerInput as SignOnlySigner

  const signingKey = core.getInput('signing-key') || undefined
  validateSigningInputs(signer, signingKey)

  return {
    evidenceManifestPath,
    diskPath: core.getInput('disk-path') || undefined,
    signer,
    signingKey,
    githubToken: core.getInput('github-token')
  }
}
