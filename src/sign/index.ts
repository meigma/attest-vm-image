import type { Inputs } from '../inputs.js'
import type { Signer } from './types.js'
import { GithubSigner } from './github.js'
import { CosignKeySigner, KmsSigner, SigstoreKeylessSigner } from './cosign.js'

export type { SignArtifact, SignContext, SignResult, Signer } from './types.js'

/**
 * Select the signing backend named by `inputs.signer`. Returns `null` for
 * `none` (no signing) and the exact requested implementation for each supported
 * backend. Unimplemented values throw a diagnostic naming the requested backend
 * and NEVER fall back, so a caller cannot silently get a different signer.
 */
export function selectSigner(inputs: Inputs): Signer | null {
  switch (inputs.signer) {
    case 'none':
      return null
    case 'github':
      return new GithubSigner(inputs.githubToken)
    case 'sigstore-keyless':
      return new SigstoreKeylessSigner()
    case 'cosign-key':
      return new CosignKeySigner(inputs.signingKey as string)
    case 'kms':
      return new KmsSigner(inputs.signingKey as string)
    default: {
      const exhaustive: never = inputs.signer
      throw new Error(
        `internal error: unsupported signer "${String(exhaustive)}"`
      )
    }
  }
}
