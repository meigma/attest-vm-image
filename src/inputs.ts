import * as fs from 'node:fs'
import * as core from '@actions/core'

/** Signing backend selected by the caller. */
export type Signer =
  'none' | 'github' | 'sigstore-keyless' | 'cosign-key' | 'kms'

/** SBOM serialization format. */
export type SbomFormat = 'spdx-json' | 'cyclonedx-json'

/** Vulnerability severity threshold that fails the run. */
export type FailOnSeverity = 'critical' | 'high' | 'none'

/** Parsed, validated action inputs with defaults applied. */
export interface Inputs {
  diskPath: string
  metadataPath?: string
  buildManifestPath?: string
  outputDirectory: string
  sbomFormat: SbomFormat
  failOnSeverity: FailOnSeverity
  policyPath?: string
  signer: Signer
  signingKey?: string
  /**
   * GitHub API token used by `signer: github` to push attestations. Sourced
   * from the `github-token` input, which defaults to the job's
   * `${{ github.token }}`; empty when unset. Never assume an ambient
   * `GITHUB_TOKEN` env var — the runner does not inject one for `uses: ./`.
   */
  githubToken: string
}

const SIGNERS: readonly Signer[] = [
  'none',
  'github',
  'sigstore-keyless',
  'cosign-key',
  'kms'
]
const SBOM_FORMATS: readonly SbomFormat[] = ['spdx-json', 'cyclonedx-json']
const FAIL_ON_SEVERITIES: readonly FailOnSeverity[] = [
  'critical',
  'high',
  'none'
]

// Backends that require a `signing-key` reference. `github` and
// `sigstore-keyless` derive their identity from workflow OIDC and need none.
const KEY_REFERENCE_BACKENDS: readonly Signer[] = ['cosign-key', 'kms']
const ENV_KEY_REFERENCE = /^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/
const KMS_KEY_REFERENCES = {
  aws: /^awskms:\/\/\/arn:(?:aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key\/(?:mrk-)?[A-Fa-f0-9]{8}-?[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{4}-?[A-Fa-f0-9]{12}$/,
  gcp: /^gcpkms:\/\/projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/versions\/[1-9][0-9]*$/,
  azure:
    /^azurekms:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.vault\.azure\.net\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9]+$/,
  vault: /^hashivault:\/\/[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/,
  openbao: /^openbao:\/\/[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/
} as const

/**
 * Read `@actions/core` inputs, apply defaults, and validate them into a typed
 * `Inputs` object. Throws an `Error` with a specific, distinct message on the
 * first invalid input so stage 1 can fail closed before any tool runs.
 */
export function parseInputs(): Inputs {
  const diskPath = core.getInput('disk-path')
  if (!diskPath) {
    throw new Error('disk-path is required but was not provided.')
  }

  const outputDirectory = core.getInput('output-directory') || './evidence'

  const sbomFormat = (core.getInput('sbom-format') || 'spdx-json') as SbomFormat
  if (!SBOM_FORMATS.includes(sbomFormat)) {
    throw new Error(
      `sbom-format must be one of ${SBOM_FORMATS.join(', ')}; got "${sbomFormat}".`
    )
  }

  const failOnSeverity = (core.getInput('fail-on-severity') ||
    'high') as FailOnSeverity
  if (!FAIL_ON_SEVERITIES.includes(failOnSeverity)) {
    throw new Error(
      `fail-on-severity must be one of ${FAIL_ON_SEVERITIES.join(
        ', '
      )}; got "${failOnSeverity}".`
    )
  }

  const signer = (core.getInput('signer') || 'none') as Signer
  if (!SIGNERS.includes(signer)) {
    throw new Error(
      `signer must be one of ${SIGNERS.join(', ')}; got "${signer}".`
    )
  }

  const signingKey = core.getInput('signing-key') || undefined
  if (KEY_REFERENCE_BACKENDS.includes(signer) && !signingKey) {
    throw new Error(
      `signer "${signer}" requires a signing-key reference, but none was provided.`
    )
  }
  if (signingKey && !KEY_REFERENCE_BACKENDS.includes(signer)) {
    throw new Error(
      `signer "${signer}" does not accept signing-key; remove the contradictory input.`
    )
  }
  if (
    signingKey &&
    /[\r\n]|-----BEGIN [^-]*PRIVATE KEY-----/.test(signingKey)
  ) {
    throw new Error(
      'signing-key must be a key reference, never raw private-key bytes.'
    )
  }
  if (signer === 'cosign-key' && signingKey) {
    const envMatch = ENV_KEY_REFERENCE.exec(signingKey)
    if (signingKey.startsWith('env://')) {
      if (!envMatch) {
        throw new Error(
          'signer "cosign-key" requires signing-key to be a readable encrypted key file or env://NAME.'
        )
      }
      const secret = process.env[envMatch[1]]
      if (!secret) {
        throw new Error(
          `signing-key references environment variable ${envMatch[1]}, but it is unset or empty.`
        )
      }
      core.setSecret(secret)
    } else {
      if (signingKey.includes('://')) {
        throw new Error(
          'signer "cosign-key" requires signing-key to be a readable encrypted key file or env://NAME.'
        )
      }
      try {
        fs.accessSync(signingKey, fs.constants.R_OK)
      } catch {
        throw new Error(
          'signer "cosign-key" signing-key file does not exist or is not readable.'
        )
      }
    }

    const password = process.env.COSIGN_PASSWORD
    if (!password) {
      throw new Error(
        'signer "cosign-key" requires the COSIGN_PASSWORD environment variable for the encrypted key.'
      )
    }
    core.setSecret(password)
  }
  if (signer === 'kms' && signingKey) {
    const provider = Object.entries(KMS_KEY_REFERENCES).find(([, pattern]) =>
      pattern.test(signingKey)
    )?.[0]
    if (!provider) {
      throw new Error(
        'signer "kms" requires signing-key to be an immutable awskms, gcpkms, or azurekms key-version URI, or a hashivault/openbao Transit key URI.'
      )
    }
    // KMS locators are not credentials, but may disclose account, project,
    // vault, and key names. Mask the exact value as a defense in depth.
    core.setSecret(signingKey)

    if (provider === 'vault') {
      assertTransitEnvironment('hashivault', 'VAULT_ADDR', 'VAULT_TOKEN')
    } else if (provider === 'openbao') {
      assertTransitEnvironment('openbao', 'BAO_ADDR', 'BAO_TOKEN')
    }
  }
  if (signer === 'sigstore-keyless') {
    const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (!oidcRequestUrl || !oidcRequestToken) {
      throw new Error(
        'signer "sigstore-keyless" requires the job permission id-token: write; the GitHub Actions OIDC request environment is unavailable.'
      )
    }
    core.setSecret(oidcRequestToken)
  }

  const policyPath = core.getInput('policy-path') || undefined
  if (policyPath) {
    try {
      fs.accessSync(policyPath, fs.constants.R_OK)
    } catch {
      throw new Error(
        `policy-path "${policyPath}" does not exist or is not readable.`
      )
    }
  }

  return {
    diskPath,
    metadataPath: core.getInput('metadata-path') || undefined,
    buildManifestPath: core.getInput('build-manifest-path') || undefined,
    outputDirectory,
    sbomFormat,
    failOnSeverity,
    policyPath,
    signer,
    signingKey,
    githubToken: core.getInput('github-token')
  }
}

function assertTransitEnvironment(
  provider: 'hashivault' | 'openbao',
  addressName: 'VAULT_ADDR' | 'BAO_ADDR',
  tokenName: 'VAULT_TOKEN' | 'BAO_TOKEN'
): void {
  if (!process.env[addressName] || !process.env[tokenName]) {
    throw new Error(
      `signer "kms" with ${provider} requires ambient ${addressName} and ${tokenName} environment variables.`
    )
  }
  core.setSecret(process.env[tokenName])
}
