import * as fs from 'node:fs'
import * as path from 'node:path'
import { exec } from '../exec.js'
import { ensureBinary } from '../tools.js'
import { BUNDLE_DIR, buildExternalStatements } from './statements.js'
import type { ExternalStatement } from './statements.js'
import type { SignContext, SignResult, Signer } from './types.js'

const BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json'

/** Offline encrypted-key signing with no Fulcio, OIDC, Rekor, or TSA service. */
export class CosignKeySigner implements Signer {
  constructor(private readonly keyReference: string) {}

  async sign(ctx: SignContext): Promise<SignResult> {
    const password = process.env.COSIGN_PASSWORD
    if (!password) {
      throw new Error(
        'signer "cosign-key" requires the COSIGN_PASSWORD environment variable for the encrypted key.'
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
        ['public-key', '--key', this.keyReference, '--outfile', publicKeyPath],
        {
          displayLabel: 'cosign public-key --key [REDACTED]',
          silent: true,
          redactStderr: true
        }
      )

      for (const item of statements) {
        await this.signAndVerify({
          cosign,
          ctx,
          item,
          configPath,
          publicKeyPath,
          stagingRoot,
          stagingBundleDir
        })
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

  private async signAndVerify(options: {
    cosign: string
    ctx: SignContext
    item: ExternalStatement
    configPath: string
    publicKeyPath: string
    stagingRoot: string
    stagingBundleDir: string
  }): Promise<void> {
    const { cosign, ctx, item, configPath, publicKeyPath } = options
    const statementPath = path.join(options.stagingRoot, `${item.role}.json`)
    const bundlePath = path.join(options.stagingBundleDir, item.filename)
    await fs.promises.writeFile(
      statementPath,
      JSON.stringify(item.statement, null, 2)
    )

    await exec(
      cosign,
      [
        'attest-blob',
        '--statement',
        statementPath,
        '--key',
        this.keyReference,
        '--bundle',
        bundlePath,
        '--signing-config',
        configPath,
        '--yes'
      ],
      {
        displayLabel: `cosign attest-blob (${item.role}, key [REDACTED])`,
        silent: true,
        redactStderr: true
      }
    )

    await assertBundle(bundlePath, item.statement)
    await exec(
      cosign,
      [
        'verify-blob-attestation',
        '--bundle',
        bundlePath,
        '--key',
        publicKeyPath,
        '--insecure-ignore-tlog',
        '--digest',
        ctx.disk.sha256,
        '--digestAlg',
        'sha256',
        '--type',
        item.predicateType
      ],
      {
        displayLabel: `cosign verify-blob-attestation (${item.role})`,
        silent: true
      }
    )
  }
}

async function assertBundle(
  bundlePath: string,
  intendedStatement: ExternalStatement['statement']
): Promise<void> {
  const bundle = JSON.parse(await fs.promises.readFile(bundlePath, 'utf8')) as {
    mediaType?: unknown
    dsseEnvelope?: { payload?: unknown }
    verificationMaterial?: { tlogEntries?: unknown[] }
  }
  if (bundle.mediaType !== BUNDLE_MEDIA_TYPE) {
    throw new Error(`Cosign produced an unexpected bundle media type.`)
  }
  if (!Array.isArray(bundle.verificationMaterial?.tlogEntries)) {
    throw new Error('Cosign bundle is missing transparency-log metadata.')
  }
  if (bundle.verificationMaterial.tlogEntries.length !== 0) {
    throw new Error(
      'Cosign unexpectedly published transparency-log material for signer "cosign-key".'
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
