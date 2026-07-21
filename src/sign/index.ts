import type { Inputs } from '../inputs.js'
import type { Signer } from './types.js'
import { GithubSigner } from './github.js'

export type { SignArtifact, SignContext, SignResult, Signer } from './types.js'

/**
 * Select the signing backend named by `inputs.signer`. Returns `null` for
 * `none` (no signing) and a `GithubSigner` for `github`. Every other value is a
 * post-v1 extension point that is not yet implemented: dispatch throws a
 * diagnostic naming the requested backend and NEVER falls back to a different
 * one, so a caller can never silently get a signer they did not ask for.
 */
export function selectSigner(inputs: Inputs): Signer | null {
  switch (inputs.signer) {
    case 'none':
      return null
    case 'github':
      return new GithubSigner(inputs.githubToken)
    default:
      throw new Error(
        `signer "${inputs.signer}" is not yet implemented. v1 supports ` +
          'only "none" and "github"; the external backends ' +
          '(sigstore-keyless, cosign-key, kms) are a post-v1 extension point, ' +
          'and this action never falls back to a different backend.'
      )
  }
}
