/**
 * Unit tests for src/inputs.ts.
 *
 * '@actions/core' is mocked via the shared fixture so getInput is controlled
 * per test, and 'node:fs' is mocked so the policy-path readability check is
 * deterministic without touching the filesystem.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

const accessSync = jest.fn<(path: string, mode?: number) => void>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('node:fs', () => ({
  accessSync,
  constants: { R_OK: 4 }
}))

const { parseInputs } = await import('../src/inputs.js')

/** Configure core.getInput to return values from a name->value map. */
function withInputs(values: Record<string, string>): void {
  core.getInput.mockImplementation((name: string) => values[name] ?? '')
}

describe('inputs.ts', () => {
  beforeEach(() => {
    // Default: policy files are readable unless a test overrides it.
    accessSync.mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.resetAllMocks()
    delete process.env.COSIGN_PASSWORD
    delete process.env.COSIGN_PRIVATE_KEY
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  })

  it('applies defaults when only disk-path is provided', () => {
    withInputs({ 'disk-path': 'disk.qcow2' })

    const inputs = parseInputs()

    expect(inputs).toEqual({
      diskPath: 'disk.qcow2',
      metadataPath: undefined,
      buildManifestPath: undefined,
      outputDirectory: './evidence',
      sbomFormat: 'spdx-json',
      failOnSeverity: 'high',
      policyPath: undefined,
      signer: 'none',
      signingKey: undefined,
      githubToken: ''
    })
  })

  it('passes through provided optional values', () => {
    withInputs({
      'disk-path': 'disk.qcow2',
      'metadata-path': 'meta.tar',
      'build-manifest-path': 'manifest.json',
      'output-directory': './out',
      'sbom-format': 'cyclonedx-json',
      'fail-on-severity': 'critical',
      signer: 'github'
    })

    const inputs = parseInputs()

    expect(inputs.metadataPath).toBe('meta.tar')
    expect(inputs.buildManifestPath).toBe('manifest.json')
    expect(inputs.outputDirectory).toBe('./out')
    expect(inputs.sbomFormat).toBe('cyclonedx-json')
    expect(inputs.failOnSeverity).toBe('critical')
    expect(inputs.signer).toBe('github')
  })

  it('rejects a missing disk-path', () => {
    withInputs({})

    expect(() => parseInputs()).toThrow(
      'disk-path is required but was not provided.'
    )
  })

  it('rejects an invalid sbom-format with a distinct message', () => {
    withInputs({ 'disk-path': 'disk.qcow2', 'sbom-format': 'json' })

    expect(() => parseInputs()).toThrow(/^sbom-format must be one of/)
  })

  it('rejects an invalid fail-on-severity with a distinct message', () => {
    withInputs({ 'disk-path': 'disk.qcow2', 'fail-on-severity': 'medium' })

    expect(() => parseInputs()).toThrow(/^fail-on-severity must be one of/)
  })

  it('rejects an invalid signer with a distinct message', () => {
    withInputs({ 'disk-path': 'disk.qcow2', signer: 'notary' })

    expect(() => parseInputs()).toThrow(/^signer must be one of/)
  })

  it('requires a signing-key for the cosign-key backend', () => {
    withInputs({ 'disk-path': 'disk.qcow2', signer: 'cosign-key' })

    expect(() => parseInputs()).toThrow(
      'signer "cosign-key" requires a signing-key reference, but none was provided.'
    )
  })

  it('requires a signing-key for the kms backend', () => {
    withInputs({ 'disk-path': 'disk.qcow2', signer: 'kms' })

    expect(() => parseInputs()).toThrow(
      'signer "kms" requires a signing-key reference, but none was provided.'
    )
  })

  it('does not require a signing-key for the github backend', () => {
    withInputs({ 'disk-path': 'disk.qcow2', signer: 'github' })

    expect(() => parseInputs()).not.toThrow()
  })

  it('accepts sigstore-keyless only when the OIDC request environment is available', () => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
      'https://token.actions.githubusercontent.com/request'
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'oidc-request-token'
    withInputs({ 'disk-path': 'disk.qcow2', signer: 'sigstore-keyless' })

    expect(parseInputs().signer).toBe('sigstore-keyless')
    expect(core.setSecret).toHaveBeenCalledWith('oidc-request-token')
  })

  it('fails sigstore-keyless immediately with a named id-token diagnostic', () => {
    withInputs({ 'disk-path': 'disk.qcow2', signer: 'sigstore-keyless' })

    expect(() => parseInputs()).toThrow(
      'signer "sigstore-keyless" requires the job permission id-token: write; the GitHub Actions OIDC request environment is unavailable.'
    )
  })

  it('reads the github-token input', () => {
    withInputs({ 'disk-path': 'disk.qcow2', 'github-token': 'ghs_from_input' })

    expect(parseInputs().githubToken).toBe('ghs_from_input')
  })

  it('accepts a cosign-key backend when a signing-key is given', () => {
    process.env.COSIGN_PASSWORD = 'password'
    withInputs({
      'disk-path': 'disk.qcow2',
      signer: 'cosign-key',
      'signing-key': 'cosign.key'
    })

    const inputs = parseInputs()

    expect(inputs.signer).toBe('cosign-key')
    expect(inputs.signingKey).toBe('cosign.key')
    expect(core.setSecret).toHaveBeenCalledWith('password')
  })

  it('accepts env://NAME, validates the variable, and masks both secrets', () => {
    process.env.COSIGN_PASSWORD = 'password'
    process.env.COSIGN_PRIVATE_KEY = 'encrypted-private-key'
    withInputs({
      'disk-path': 'disk.qcow2',
      signer: 'cosign-key',
      'signing-key': 'env://COSIGN_PRIVATE_KEY'
    })

    expect(parseInputs().signingKey).toBe('env://COSIGN_PRIVATE_KEY')
    expect(core.setSecret).toHaveBeenCalledWith('encrypted-private-key')
    expect(core.setSecret).toHaveBeenCalledWith('password')
  })

  it('rejects an unset env:// key reference', () => {
    process.env.COSIGN_PASSWORD = 'password'
    withInputs({
      'disk-path': 'disk.qcow2',
      signer: 'cosign-key',
      'signing-key': 'env://MISSING_KEY'
    })

    expect(() => parseInputs()).toThrow(/MISSING_KEY.*unset or empty/)
  })

  it('rejects malformed env references and unsupported URI schemes', () => {
    process.env.COSIGN_PASSWORD = 'password'
    for (const signingKey of ['env://BAD-NAME', 'awskms:///key']) {
      withInputs({
        'disk-path': 'disk.qcow2',
        signer: 'cosign-key',
        'signing-key': signingKey
      })
      expect(() => parseInputs()).toThrow(
        /readable encrypted key file or env:\/\/NAME/
      )
    }
  })

  it('rejects unreadable key files without echoing the path', () => {
    process.env.COSIGN_PASSWORD = 'password'
    accessSync.mockImplementation(() => {
      throw new Error('EACCES')
    })
    withInputs({
      'disk-path': 'disk.qcow2',
      signer: 'cosign-key',
      'signing-key': '/secret/cosign.key'
    })

    const error = (() => {
      try {
        parseInputs()
      } catch (caught) {
        return caught as Error
      }
      throw new Error('expected parseInputs to throw')
    })()
    expect(error.message).toMatch(/does not exist or is not readable/)
    expect(error.message).not.toContain('/secret/cosign.key')
  })

  it('requires COSIGN_PASSWORD for encrypted key signing', () => {
    withInputs({
      'disk-path': 'disk.qcow2',
      signer: 'cosign-key',
      'signing-key': 'cosign.key'
    })

    expect(() => parseInputs()).toThrow(/requires the COSIGN_PASSWORD/)
  })

  it('rejects raw private-key bytes and contradictory signing-key inputs', () => {
    withInputs({
      'disk-path': 'disk.qcow2',
      signer: 'cosign-key',
      'signing-key': '-----BEGIN ENCRYPTED PRIVATE KEY-----\nsecret'
    })
    expect(() => parseInputs()).toThrow(/never raw private-key bytes/)

    for (const signer of ['github', 'sigstore-keyless']) {
      withInputs({
        'disk-path': 'disk.qcow2',
        signer,
        'signing-key': 'cosign.key'
      })
      expect(() => parseInputs()).toThrow(/does not accept signing-key/)
    }
  })

  it('rejects an unreadable policy-path', () => {
    withInputs({ 'disk-path': 'disk.qcow2', 'policy-path': 'policy.json' })
    accessSync.mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(() => parseInputs()).toThrow(
      'policy-path "policy.json" does not exist or is not readable.'
    )
  })

  it('accepts a readable policy-path', () => {
    withInputs({ 'disk-path': 'disk.qcow2', 'policy-path': 'policy.json' })

    const inputs = parseInputs()

    expect(inputs.policyPath).toBe('policy.json')
    expect(accessSync).toHaveBeenCalledWith('policy.json', 4)
  })

  it('emits distinct messages across the three enum rejections', () => {
    const messages = new Set<string>()
    for (const [name, value] of [
      ['sbom-format', 'json'],
      ['fail-on-severity', 'medium'],
      ['signer', 'notary']
    ] as const) {
      withInputs({ 'disk-path': 'disk.qcow2', [name]: value })
      try {
        parseInputs()
      } catch (error) {
        messages.add((error as Error).message)
      }
    }
    expect(messages.size).toBe(3)
  })
})
