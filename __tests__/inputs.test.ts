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

  it('reads the github-token input', () => {
    withInputs({ 'disk-path': 'disk.qcow2', 'github-token': 'ghs_from_input' })

    expect(parseInputs().githubToken).toBe('ghs_from_input')
  })

  it('accepts a cosign-key backend when a signing-key is given', () => {
    withInputs({
      'disk-path': 'disk.qcow2',
      signer: 'cosign-key',
      'signing-key': 'cosign.key'
    })

    const inputs = parseInputs()

    expect(inputs.signer).toBe('cosign-key')
    expect(inputs.signingKey).toBe('cosign.key')
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
