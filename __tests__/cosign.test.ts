import { jest } from '@jest/globals'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'
import type { ExecResult } from '../src/exec.js'
import { PREDICATE_TYPE, STATEMENT_TYPE } from '../src/predicate.js'
import type { Statement } from '../src/predicate.js'

const exec =
  jest.fn<
    (cmd: string, args?: string[], opts?: object) => Promise<ExecResult>
  >()
const ensureBinary = jest.fn<(name: string) => Promise<string>>()

jest.unstable_mockModule('../src/exec.js', () => ({ exec }))
jest.unstable_mockModule('../src/tools.js', () => ({ ensureBinary }))
jest.unstable_mockModule('@actions/core', () => core)

const { CosignKeySigner, KmsSigner, SigstoreKeylessSigner } =
  await import('../src/sign/cosign.js')

const DISK_SHA = 'a'.repeat(64)
const SBOM_SHA = 'b'.repeat(64)
const REQUIRED_ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'meigma/attest-vm-image',
  GITHUB_REF: 'refs/heads/test',
  GITHUB_SHA: 'c'.repeat(40),
  GITHUB_RUN_ID: '1',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY_ID: '2',
  GITHUB_REPOSITORY_OWNER_ID: '3',
  GITHUB_WORKFLOW_REF:
    'meigma/attest-vm-image/.github/workflows/test.yml@refs/heads/test',
  RUNNER_ENVIRONMENT: 'github-hosted',
  ACTIONS_ID_TOKEN_REQUEST_URL:
    'https://token.actions.githubusercontent.com/request',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-token',
  COSIGN_PASSWORD: 'password'
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`)
  return args[index + 1]
}

describe('CosignKeySigner', () => {
  let dir: string
  let sbomPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-cosign-'))
    sbomPath = join(dir, 'sbom.spdx.json')
    writeFileSync(sbomPath, JSON.stringify({ spdxVersion: 'SPDX-2.3' }))
    Object.assign(process.env, REQUIRED_ENV)
    ensureBinary.mockResolvedValue('/tools/cosign/3.1.2')
    installSuccessfulExecMock()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const name of Object.keys(REQUIRED_ENV)) delete process.env[name]
    jest.resetAllMocks()
  })

  const context = () => ({
    disk: { path: join(dir, 'disk.qcow2'), sha256: DISK_SHA },
    sbom: {
      path: sbomPath,
      sha256: SBOM_SHA,
      format: 'spdx-json' as const
    },
    statement: {
      _type: STATEMENT_TYPE,
      subject: [{ name: 'disk.qcow2', digest: { sha256: DISK_SHA } }],
      predicateType: PREDICATE_TYPE,
      predicate: { schemaVersion: '1', result: 'pass' }
    } as unknown as Statement,
    outputDir: dir
  })

  function installSuccessfulExecMock(tlogEntries?: unknown[]): void {
    exec.mockImplementation(async (_cmd, args = []) => {
      if (args[0] === 'public-key') {
        writeFileSync(flag(args, '--outfile'), 'PUBLIC KEY')
      }
      if (args[0] === 'attest-blob') {
        const statement = JSON.parse(
          readFileSync(flag(args, '--statement'), 'utf8')
        ) as object
        writeFileSync(
          flag(args, '--bundle'),
          JSON.stringify({
            mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString('base64')
            },
            verificationMaterial:
              tlogEntries === undefined ? {} : { tlogEntries }
          })
        )
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
  }

  it('signs, verifies, and promotes exactly three offline bundles', async () => {
    const result = await new CosignKeySigner('/secret/cosign.key').sign(
      context()
    )

    expect(ensureBinary).toHaveBeenCalledWith('cosign')
    expect(result.attestationUrl).toBeUndefined()
    expect(result.bundles.map((bundle) => bundle.role)).toEqual([
      'provenance-attestation',
      'sbom-attestation',
      'validation-attestation'
    ])
    for (const bundle of result.bundles)
      expect(existsSync(bundle.path)).toBe(true)
    expect(
      exec.mock.calls.filter(([, args]) => args?.[0] === 'attest-blob')
    ).toHaveLength(3)
    expect(
      exec.mock.calls.filter(
        ([, args]) => args?.[0] === 'verify-blob-attestation'
      )
    ).toHaveLength(3)

    const configCall = exec.mock.calls.find(
      ([, args]) => args?.[0] === 'signing-config'
    )
    expect(configCall?.[1]).toEqual(
      expect.arrayContaining([
        '--no-default-fulcio',
        '--no-default-oidc',
        '--no-default-rekor',
        '--no-default-tsa'
      ])
    )
    const secretCalls = exec.mock.calls.filter(([, args]) =>
      args?.includes('/secret/cosign.key')
    )
    expect(secretCalls.length).toBeGreaterThan(0)
    for (const [, , opts] of secretCalls) {
      expect(opts).toEqual(
        expect.objectContaining({
          displayLabel: expect.stringContaining('[REDACTED]'),
          silent: true,
          redactStderr: true
        })
      )
      expect(JSON.stringify(opts)).not.toContain('/secret/cosign.key')
    }
  })

  it('accepts Cosign v0.3 omitting an empty tlogEntries field', async () => {
    const result = await new CosignKeySigner('/secret/cosign.key').sign(
      context()
    )

    const bundle = JSON.parse(readFileSync(result.bundles[0].path, 'utf8')) as {
      verificationMaterial: object
    }
    expect(bundle.verificationMaterial).not.toHaveProperty('tlogEntries')
    expect(result.bundles).toHaveLength(3)
  })

  it('passes env://NAME as a reference without putting it in log labels', async () => {
    const result = await new CosignKeySigner('env://COSIGN_PRIVATE_KEY').sign(
      context()
    )

    expect(result.bundles).toHaveLength(3)
    for (const [, args, opts] of exec.mock.calls.filter(([, args]) =>
      args?.includes('env://COSIGN_PRIVATE_KEY')
    )) {
      expect(args).toContain('env://COSIGN_PRIVATE_KEY')
      expect(JSON.stringify(opts)).not.toContain('COSIGN_PRIVATE_KEY')
    }
  })

  it('removes staged bundles and publishes none when verification fails', async () => {
    let verifies = 0
    const successful = exec.getMockImplementation()
    exec.mockImplementation(async (cmd, args = [], opts) => {
      if (args[0] === 'verify-blob-attestation' && ++verifies === 2) {
        throw new Error('verification failed')
      }
      return successful
        ? successful(cmd, args, opts)
        : { stdout: '', stderr: '', exitCode: 0 }
    })

    await expect(
      new CosignKeySigner('/secret/cosign.key').sign(context())
    ).rejects.toThrow('verification failed')
    expect(existsSync(join(dir, 'attestations'))).toBe(false)
    expect(
      readdirSync(dir).some((name) => name.startsWith('.attestations-'))
    ).toBe(false)
  })

  it('rejects transparency-log entries and publishes no bundles', async () => {
    installSuccessfulExecMock([{ logIndex: '1' }])

    await expect(
      new CosignKeySigner('/secret/cosign.key').sign(context())
    ).rejects.toThrow(/unexpectedly published transparency-log material/)
    expect(existsSync(join(dir, 'attestations'))).toBe(false)
  })

  it('signs and verifies three KMS bundles without a key password', async () => {
    delete process.env.COSIGN_PASSWORD
    const keyReference =
      'awskms:///arn:aws:kms:us-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab'

    const result = await new KmsSigner(keyReference).sign(context())

    expect(result.bundles).toHaveLength(3)
    expect(result.attestationUrl).toBeUndefined()
    expect(
      exec.mock.calls.filter(([, args]) => args?.[0] === 'public-key')
    ).toHaveLength(1)
    const keyCalls = exec.mock.calls.filter(([, args]) =>
      args?.includes(keyReference)
    )
    expect(keyCalls).toHaveLength(4)
    for (const [, , opts] of keyCalls) {
      expect(opts).toEqual(
        expect.objectContaining({
          displayLabel: expect.stringContaining('[REDACTED]'),
          silent: true,
          redactStderr: true
        })
      )
      expect(JSON.stringify(opts)).not.toContain(keyReference)
    }
    for (const [, args] of exec.mock.calls.filter(
      ([, args]) => args?.[0] === 'attest-blob'
    )) {
      expect(args).toEqual(
        expect.arrayContaining(['--key', keyReference, '--signing-config'])
      )
    }
  })

  it('fails a KMS authentication error without signing or fallback', async () => {
    const successful = exec.getMockImplementation()
    exec.mockImplementation(async (cmd, args = [], opts) => {
      if (args[0] === 'public-key') {
        throw new Error(
          'Command failed with exit code 1: cosign public-key [REDACTED]'
        )
      }
      return successful
        ? successful(cmd, args, opts)
        : { stdout: '', stderr: '', exitCode: 0 }
    })

    await expect(
      new KmsSigner(
        'awskms:///arn:aws:kms:us-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab'
      ).sign(context())
    ).rejects.toThrow('[REDACTED]')
    expect(
      exec.mock.calls.filter(([, args]) => args?.[0] === 'attest-blob')
    ).toHaveLength(0)
    expect(existsSync(join(dir, 'attestations'))).toBe(false)
  })

  it('rejects transparency material in a KMS bundle by backend name', async () => {
    installSuccessfulExecMock([{ logIndex: '1' }])

    await expect(
      new KmsSigner(
        'awskms:///arn:aws:kms:us-west-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab'
      ).sign(context())
    ).rejects.toThrow(/signer "kms"/)
    expect(existsSync(join(dir, 'attestations'))).toBe(false)
  })

  it.each(['hashivault://cosign', 'openbao://cosign'])(
    'checks the public-key fingerprint before and after signing for %s',
    async (keyReference) => {
      const result = await new KmsSigner(keyReference).sign(context())

      expect(result.bundles).toHaveLength(3)
      expect(
        exec.mock.calls.filter(([, args]) => args?.[0] === 'public-key')
      ).toHaveLength(2)
    }
  )

  it('rejects a Vault rotation and publishes no bundles', async () => {
    let publicKeyReads = 0
    const successful = exec.getMockImplementation()
    exec.mockImplementation(async (cmd, args = [], opts) => {
      const result = successful
        ? await successful(cmd, args, opts)
        : { stdout: '', stderr: '', exitCode: 0 }
      if (args[0] === 'public-key' && ++publicKeyReads === 2) {
        writeFileSync(flag(args, '--outfile'), 'ROTATED PUBLIC KEY')
      }
      return result
    })

    await expect(
      new KmsSigner('hashivault://cosign').sign(context())
    ).rejects.toThrow(/public-key change during signing/)
    expect(existsSync(join(dir, 'attestations'))).toBe(false)
    expect(
      readdirSync(dir).some((name) => name.startsWith('.attestations-'))
    ).toBe(false)
  })

  it('signs and verifies three keyless bundles with exact identity and issuer', async () => {
    installSuccessfulExecMock([{ logIndex: '1' }])

    const result = await new SigstoreKeylessSigner().sign(context())

    expect(result.bundles).toHaveLength(3)
    expect(result.attestationUrl).toBeUndefined()
    expect(core.notice).toHaveBeenCalledWith(
      expect.stringContaining('permanent public Sigstore transparency records')
    )
    const signCalls = exec.mock.calls.filter(
      ([, args]) => args?.[0] === 'attest-blob'
    )
    expect(signCalls).toHaveLength(3)
    for (const [, args] of signCalls) {
      expect(args).toEqual(
        expect.arrayContaining(['--oidc-provider', 'github-actions'])
      )
      expect(args).not.toContain('--key')
      expect(args).not.toContain('--signing-config')
    }
    const verifyCalls = exec.mock.calls.filter(
      ([, args]) => args?.[0] === 'verify-blob-attestation'
    )
    expect(verifyCalls).toHaveLength(3)
    for (const [, args] of verifyCalls) {
      expect(args).toEqual(
        expect.arrayContaining([
          '--certificate-identity',
          'https://github.com/meigma/attest-vm-image/.github/workflows/test.yml@refs/heads/test',
          '--certificate-oidc-issuer',
          'https://token.actions.githubusercontent.com'
        ])
      )
      expect(args).not.toContain('--insecure-ignore-tlog')
    }
  })

  it('rejects keyless bundles without a public transparency entry', async () => {
    installSuccessfulExecMock()

    await expect(new SigstoreKeylessSigner().sign(context())).rejects.toThrow(
      /missing its required public transparency-log entry/
    )
    expect(existsSync(join(dir, 'attestations'))).toBe(false)
  })

  it('preflights keyless OIDC before downloading Cosign', async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

    await expect(new SigstoreKeylessSigner().sign(context())).rejects.toThrow(
      /requires the job permission id-token: write/
    )
    expect(ensureBinary).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })
})
