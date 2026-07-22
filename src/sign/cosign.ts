import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import * as core from '@actions/core'
import { exec } from '../exec.js'
import { ensureBinary } from '../tools.js'
import { BUNDLE_DIR, buildExternalStatements } from './statements.js'
import type { ExternalStatement } from './statements.js'
import type { SignContext, SignResult, Signer } from './types.js'

const BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json'
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com'

type CosignConfiguration =
  | { kind: 'key'; keyReference: string }
  | { kind: 'kms'; keyReference: string; fingerprintGuard: boolean }
  | { kind: 'keyless'; certificateIdentity: string }

type KeyMaterial = {
  configPath: string
  publicKeyPath: string
}

/** Offline encrypted-key signing with no Fulcio, OIDC, Rekor, or TSA service. */
export class CosignKeySigner implements Signer {
  private readonly signer: CosignSigner

  constructor(keyReference: string) {
    this.signer = new CosignSigner({ kind: 'key', keyReference })
  }

  sign(ctx: SignContext): Promise<SignResult> {
    return this.signer.sign(ctx)
  }
}

/** Public Sigstore signing with the exact GitHub Actions workflow identity. */
export class SigstoreKeylessSigner implements Signer {
  private readonly signer = new CosignSigner({
    kind: 'keyless',
    certificateIdentity: keylessCertificateIdentity()
  })

  sign(ctx: SignContext): Promise<SignResult> {
    return this.signer.sign(ctx)
  }
}

/** KMS-backed signing with ambient provider credentials and no public services. */
export class KmsSigner implements Signer {
  private readonly signer: CosignSigner

  constructor(keyReference: string) {
    this.signer = new CosignSigner({
      kind: 'kms',
      keyReference,
      fingerprintGuard:
        keyReference.startsWith('hashivault://') ||
        keyReference.startsWith('openbao://')
    })
  }

  sign(ctx: SignContext): Promise<SignResult> {
    return this.signer.sign(ctx)
  }
}

class CosignSigner implements Signer {
  constructor(private readonly configuration: CosignConfiguration) {}

  async sign(ctx: SignContext): Promise<SignResult> {
    if (this.configuration.kind === 'key' && !process.env.COSIGN_PASSWORD) {
      throw new Error(
        'signer "cosign-key" requires the COSIGN_PASSWORD environment variable for the encrypted key.'
      )
    }
    if (this.configuration.kind === 'keyless') {
      assertKeylessOidcEnvironment()
      core.notice(
        'signer "sigstore-keyless" publishes permanent public Sigstore transparency records that disclose the repository, workflow, ref, commit, run, and certificate identity.'
      )
    }

    const cosignDir = await ensureBinary('cosign')
    const cosign = path.join(cosignDir, 'cosign')
    const statements = await buildExternalStatements(ctx)
    const finalBundleDir = path.join(ctx.outputDir, BUNDLE_DIR)
    const stagingRoot = await fs.promises.mkdtemp(
      path.join(ctx.outputDir, '.attestations-')
    )
    const stagingBundleDir = path.join(stagingRoot, BUNDLE_DIR)

    try {
      await fs.promises.access(finalBundleDir).then(
        () => {
          throw new Error(
            `attestation bundle directory "${finalBundleDir}" already exists; refusing to overwrite it.`
          )
        },
        () => undefined
      )
      await fs.promises.mkdir(stagingBundleDir)

      const keyMaterial =
        this.configuration.kind !== 'keyless'
          ? await this.prepareKeyMaterial(cosign, stagingRoot)
          : undefined

      for (const item of statements) {
        await this.signAndVerify({
          cosign,
          ctx,
          item,
          keyMaterial,
          stagingRoot,
          stagingBundleDir
        })
      }

      if (
        this.configuration.kind === 'kms' &&
        this.configuration.fingerprintGuard
      ) {
        if (!keyMaterial) {
          throw new Error('internal error: KMS key material is missing')
        }
        await this.assertKmsPublicKeyUnchanged(
          cosign,
          stagingRoot,
          keyMaterial.publicKeyPath
        )
      }

      await fs.promises.rename(stagingBundleDir, finalBundleDir)
      return {
        bundleDir: finalBundleDir,
        bundles: statements.map(({ role, filename }) => ({
          role,
          path: path.join(finalBundleDir, filename)
        }))
      }
    } finally {
      await fs.promises.rm(stagingRoot, { recursive: true, force: true })
    }
  }

  private async prepareKeyMaterial(
    cosign: string,
    stagingRoot: string
  ): Promise<KeyMaterial> {
    if (this.configuration.kind === 'keyless') {
      throw new Error(
        'internal error: key material requested for keyless signing'
      )
    }
    const configPath = path.join(stagingRoot, 'signing-config.json')
    const publicKeyPath = path.join(stagingRoot, 'cosign.pub')
    await exec(
      cosign,
      [
        'signing-config',
        'create',
        '--no-default-fulcio',
        '--no-default-oidc',
        '--no-default-rekor',
        '--no-default-tsa',
        '--out',
        configPath
      ],
      {
        displayLabel: 'cosign signing-config create (no services)',
        silent: true
      }
    )
    await exec(
      cosign,
      [
        'public-key',
        '--key',
        this.configuration.keyReference,
        '--outfile',
        publicKeyPath
      ],
      {
        displayLabel: 'cosign public-key --key [REDACTED]',
        silent: true,
        redactStderr: true
      }
    )
    return { configPath, publicKeyPath }
  }

  private async assertKmsPublicKeyUnchanged(
    cosign: string,
    stagingRoot: string,
    beforePath: string
  ): Promise<void> {
    if (this.configuration.kind !== 'kms') {
      throw new Error(
        'internal error: KMS fingerprint guard used by non-KMS signer'
      )
    }
    const afterPath = path.join(stagingRoot, 'cosign-after.pub')
    await exec(
      cosign,
      [
        'public-key',
        '--key',
        this.configuration.keyReference,
        '--outfile',
        afterPath
      ],
      {
        displayLabel: 'cosign public-key --key [REDACTED] (rotation check)',
        silent: true,
        redactStderr: true
      }
    )
    const [before, after] = await Promise.all([
      publicKeyFingerprint(beforePath),
      publicKeyFingerprint(afterPath)
    ])
    if (before !== after) {
      throw new Error(
        'signer "kms" detected a Vault/OpenBao public-key change during signing; no attestation bundles were published.'
      )
    }
  }

  private async signAndVerify(options: {
    cosign: string
    ctx: SignContext
    item: ExternalStatement
    keyMaterial?: KeyMaterial
    stagingRoot: string
    stagingBundleDir: string
  }): Promise<void> {
    const { cosign, ctx, item, keyMaterial } = options
    const statementPath = path.join(options.stagingRoot, `${item.role}.json`)
    const bundlePath = path.join(options.stagingBundleDir, item.filename)
    await fs.promises.writeFile(
      statementPath,
      JSON.stringify(item.statement, null, 2)
    )

    const signArgs = ['attest-blob', '--statement', statementPath]
    if (this.configuration.kind !== 'keyless') {
      if (!keyMaterial) {
        throw new Error(
          'internal error: key-backed signing material is missing'
        )
      }
      signArgs.push(
        '--key',
        this.configuration.keyReference,
        '--signing-config',
        keyMaterial.configPath
      )
    } else {
      signArgs.push('--oidc-provider', 'github-actions')
    }
    signArgs.push('--bundle', bundlePath, '--yes')
    await exec(cosign, signArgs, {
      displayLabel:
        this.configuration.kind !== 'keyless'
          ? `cosign attest-blob (${item.role}, ${this.configuration.kind} key [REDACTED])`
          : `cosign attest-blob (${item.role}, GitHub Actions OIDC)`,
      silent: true,
      redactStderr: this.configuration.kind !== 'keyless'
    })

    await assertBundle(bundlePath, item.statement, this.configuration.kind)
    const verifyArgs = ['verify-blob-attestation', '--bundle', bundlePath]
    if (this.configuration.kind !== 'keyless') {
      if (!keyMaterial) {
        throw new Error(
          'internal error: key-backed verification material is missing'
        )
      }
      verifyArgs.push(
        '--key',
        keyMaterial.publicKeyPath,
        '--insecure-ignore-tlog'
      )
    } else {
      verifyArgs.push(
        '--certificate-identity',
        this.configuration.certificateIdentity,
        '--certificate-oidc-issuer',
        GITHUB_OIDC_ISSUER
      )
    }
    verifyArgs.push(
      '--digest',
      ctx.disk.sha256,
      '--digestAlg',
      'sha256',
      '--type',
      item.predicateType
    )
    await exec(cosign, verifyArgs, {
      displayLabel: `cosign verify-blob-attestation (${item.role})`,
      silent: true
    })
  }
}

async function publicKeyFingerprint(publicKeyPath: string): Promise<string> {
  const publicKey = await fs.promises.readFile(publicKeyPath)
  return createHash('sha256').update(publicKey).digest('hex')
}

function keylessCertificateIdentity(): string {
  const serverUrl = process.env.GITHUB_SERVER_URL
  const workflowRef = process.env.GITHUB_WORKFLOW_REF
  if (!serverUrl || !workflowRef) {
    throw new Error(
      'signer "sigstore-keyless" requires GITHUB_SERVER_URL and GITHUB_WORKFLOW_REF to construct its exact certificate identity.'
    )
  }
  return `${serverUrl}/${workflowRef}`
}

function assertKeylessOidcEnvironment(): void {
  if (
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new Error(
      'signer "sigstore-keyless" requires the job permission id-token: write; the GitHub Actions OIDC request environment is unavailable.'
    )
  }
}

async function assertBundle(
  bundlePath: string,
  intendedStatement: ExternalStatement['statement'],
  signerKind: CosignConfiguration['kind']
): Promise<void> {
  const bundle = JSON.parse(await fs.promises.readFile(bundlePath, 'utf8')) as {
    mediaType?: unknown
    dsseEnvelope?: { payload?: unknown }
    verificationMaterial?: { tlogEntries?: unknown }
  }
  if (bundle.mediaType !== BUNDLE_MEDIA_TYPE) {
    throw new Error(`Cosign produced an unexpected bundle media type.`)
  }
  const tlogEntries = bundle.verificationMaterial?.tlogEntries
  // Sigstore bundle JSON omits empty repeated fields, so a key-backed v0.3
  // bundle may carry no `tlogEntries` property. Omitted and [] both mean zero.
  if (signerKind === 'keyless') {
    if (!Array.isArray(tlogEntries) || tlogEntries.length !== 1) {
      throw new Error(
        'Cosign keyless bundle is missing its required public transparency-log entry.'
      )
    }
  } else if (tlogEntries !== undefined && !Array.isArray(tlogEntries)) {
    throw new Error('Cosign bundle has invalid transparency-log metadata.')
  } else if (Array.isArray(tlogEntries) && tlogEntries.length !== 0) {
    throw new Error(
      `Cosign unexpectedly published transparency-log material for signer "${signerKind === 'kms' ? 'kms' : 'cosign-key'}".`
    )
  }
  if (typeof bundle.dsseEnvelope?.payload !== 'string') {
    throw new Error('Cosign bundle is missing its DSSE payload.')
  }
  const signedStatement = JSON.parse(
    Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')
  ) as unknown
  if (JSON.stringify(signedStatement) !== JSON.stringify(intendedStatement)) {
    throw new Error(
      'Cosign bundle payload does not match the intended statement.'
    )
  }
}
