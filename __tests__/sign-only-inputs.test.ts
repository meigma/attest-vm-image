/**
 * Unit tests for src/sign-only/inputs.ts. '@actions/core' is mocked via the
 * shared fixture; the signer/key validation itself is the real shared
 * implementation (covered in depth by inputs.test.ts), so these tests focus on
 * the sign-only-specific contract.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { parseSignOnlyInputs } = await import('../src/sign-only/inputs.js')

const KMS_URI =
  'awskms:///arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012'

/** Configure core.getInput to return values from a name->value map. */
function withInputs(values: Record<string, string>): void {
  core.getInput.mockImplementation((name: string) => values[name] ?? '')
}

describe('sign-only inputs', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  it('applies defaults and returns a validated kms selection', () => {
    withInputs({ signer: 'kms', 'signing-key': KMS_URI })

    const inputs = parseSignOnlyInputs()

    expect(inputs).toEqual({
      evidenceManifestPath: './evidence/evidence-manifest.json',
      diskPath: undefined,
      signer: 'kms',
      signingKey: KMS_URI,
      githubToken: ''
    })
  })

  it('passes through explicit manifest, disk, and token inputs', () => {
    withInputs({
      signer: 'github',
      'evidence-manifest': 'handoff/evidence-manifest.json',
      'disk-path': 'disk.qcow2',
      'github-token': 'token-value'
    })

    const inputs = parseSignOnlyInputs()

    expect(inputs.evidenceManifestPath).toBe('handoff/evidence-manifest.json')
    expect(inputs.diskPath).toBe('disk.qcow2')
    expect(inputs.githubToken).toBe('token-value')
  })

  it('requires a signer', () => {
    withInputs({})

    expect(() => parseSignOnlyInputs()).toThrow(
      'signer is required but was not provided.'
    )
  })

  it('rejects signer "none" with a distinct diagnostic', () => {
    withInputs({ signer: 'none' })

    expect(() => parseSignOnlyInputs()).toThrow(
      'signer "none" is not valid for the sign action'
    )
  })

  it('rejects an unknown signer', () => {
    withInputs({ signer: 'gpg' })

    expect(() => parseSignOnlyInputs()).toThrow(
      'signer must be one of github, sigstore-keyless, cosign-key, kms; got "gpg".'
    )
  })

  it('applies the shared signer/key validation', () => {
    withInputs({ signer: 'kms' })

    expect(() => parseSignOnlyInputs()).toThrow(
      'signer "kms" requires a signing-key reference, but none was provided.'
    )
  })

  it('rejects a contradictory signing-key for OIDC backends', () => {
    withInputs({ signer: 'github', 'signing-key': 'integration.key' })

    expect(() => parseSignOnlyInputs()).toThrow(
      'signer "github" does not accept signing-key'
    )
  })
})
