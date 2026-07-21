/**
 * Unit tests for src/main.ts, the full signer:none orchestration.
 *
 * Every stage module is mocked (no real tool, disk, or filesystem work); node:fs
 * is mocked so no evidence directory is actually created. A shared `calls` array
 * records stage invocation order so the fixed pipeline sequence can be asserted.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import type { Inputs } from '../src/inputs.js'

// ---- Stage mocks -----------------------------------------------------------

const calls: string[] = []
const record =
  <T>(name: string, value: T) =>
  async (): Promise<T> => {
    calls.push(name)
    return value
  }

const parseInputs = jest.fn<() => Inputs>()

const loadPolicy = jest.fn(
  record('loadPolicy', { policy: { id: 'builtin/v1', rules: [] } })
)
const runContamination = jest.fn(() => {
  calls.push('runContamination')
  return { checks: [], policy: { id: 'builtin/v1' } }
})

const ensureAptPackages = jest.fn(record('ensureAptPackages', undefined))
const ensureBinary = jest.fn((name: string) => {
  calls.push(`ensureBinary:${name}`)
  return Promise.resolve(`/opt/${name}`)
})
const toolVersions = jest.fn(
  record('toolVersions', [{ name: 'attest-vm-image', version: '0.1.0' }])
)

const sha256File = jest.fn(async (p: string) => {
  calls.push(`sha256File:${p}`)
  return 'manifestsha'
})

const validateDisk = jest.fn(
  record('validateDisk', {
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    virtualSize: 2,
    actualSize: 3,
    compat: '1.1'
  })
)

const inspectFilesystem = jest.fn(
  record('inspectFilesystem', {
    operatingSystem: {
      id: 'ubuntu',
      versionId: '22.04',
      prettyName: 'U',
      arch: 'x86_64'
    },
    packages: [{ name: 'openssl', version: '3' }],
    mountPath: '/tmp/m'
  })
)

const validateMetadata = jest.fn(
  record('validateMetadata', {
    sha256: 'b'.repeat(64),
    properties: { os: 'U' }
  })
)

const generateSbom = jest.fn(
  record('generateSbom', {
    path: '/evidence/sbom.spdx.json',
    format: 'spdx-json',
    sha256: 'd'.repeat(64)
  })
)

// scanVulnerabilities returns a controllable result so the fail path can be
// exercised; default is a clean pass.
let vulnResult = {
  path: '/evidence/vulnerability-report.json',
  sha256: 'e'.repeat(64),
  scanner: { name: 'grype', version: '0.116.0' },
  dbVersion: 'schema v6',
  summary: {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    negligible: 0,
    unknown: 0
  },
  thresholdExceeded: false
}
const scanVulnerabilities = jest.fn(async () => {
  calls.push('scanVulnerabilities')
  return vulnResult
})

const workflowContext = jest.fn(() => ({
  repository: 'meigma/attest-vm-image',
  ref: 'refs/heads/main',
  sha: 'deadbeef',
  runId: '1',
  runAttempt: '1',
  eventName: 'push',
  actor: 'octocat'
}))

// writeEvidence returns a statement whose result the orchestrator reads.
let evidenceResult: 'pass' | 'fail' = 'pass'
const writeEvidence = jest.fn(async () => {
  calls.push('writeEvidence')
  return { predicate: { result: evidenceResult } }
})

const writeChecksums = jest.fn(record('writeChecksums', undefined))

const drain = jest.fn(record('drain', undefined))
class CleanupRegistry {
  add = jest.fn()
  drain = drain
}

const mkdir = jest.fn(async () => {
  calls.push('mkdir')
  return undefined
})

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/inputs.js', () => ({ parseInputs }))
jest.unstable_mockModule('../src/contamination.js', () => ({
  loadPolicy,
  runContamination
}))
jest.unstable_mockModule('../src/tools.js', () => ({
  ensureAptPackages,
  ensureBinary,
  toolVersions
}))
jest.unstable_mockModule('../src/hash.js', () => ({ sha256File }))
jest.unstable_mockModule('../src/disk.js', () => ({ validateDisk }))
jest.unstable_mockModule('../src/inspect.js', () => ({ inspectFilesystem }))
jest.unstable_mockModule('../src/metadata.js', () => ({ validateMetadata }))
jest.unstable_mockModule('../src/sbom.js', () => ({ generateSbom }))
jest.unstable_mockModule('../src/vuln.js', () => ({ scanVulnerabilities }))
jest.unstable_mockModule('../src/context.js', () => ({ workflowContext }))
jest.unstable_mockModule('../src/predicate.js', () => ({ writeEvidence }))
jest.unstable_mockModule('../src/checksums.js', () => ({ writeChecksums }))
jest.unstable_mockModule('../src/cleanup.js', () => ({ CleanupRegistry }))
jest.unstable_mockModule('node:fs', () => ({
  promises: { mkdir }
}))

const { run } = await import('../src/main.js')

// ---- Fixtures --------------------------------------------------------------

function baseInputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    diskPath: 'build/disk.qcow2',
    outputDirectory: './evidence',
    sbomFormat: 'spdx-json',
    failOnSeverity: 'high',
    signer: 'none',
    ...overrides
  }
}

const outputNames = (): string[] =>
  core.setOutput.mock.calls.map((c) => c[0] as string)

describe('main.ts orchestration', () => {
  beforeEach(() => {
    calls.length = 0
    vulnResult = {
      path: '/evidence/vulnerability-report.json',
      sha256: 'e'.repeat(64),
      scanner: { name: 'grype', version: '0.116.0' },
      dbVersion: 'schema v6',
      summary: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        negligible: 0,
        unknown: 0
      },
      thresholdExceeded: false
    }
    evidenceResult = 'pass'
    parseInputs.mockReturnValue(baseInputs())
  })

  afterEach(() => {
    // clear (not reset) so the stage mocks keep their record() implementations
    // across tests; only call history is wiped. parseInputs is re-primed in
    // beforeEach.
    jest.clearAllMocks()
  })

  it('runs the stages in the fixed pipeline order', async () => {
    parseInputs.mockReturnValue(
      baseInputs({
        metadataPath: 'meta.tar.gz',
        buildManifestPath: 'manifest.json'
      })
    )

    await run()

    // The load-bearing relative order of the stages.
    const order = calls.filter((c) => c !== 'mkdir')
    expect(order).toEqual([
      'loadPolicy',
      'sha256File:manifest.json',
      'ensureAptPackages',
      'ensureBinary:syft',
      'ensureBinary:grype',
      'validateDisk',
      'inspectFilesystem',
      'validateMetadata',
      'generateSbom',
      'scanVulnerabilities',
      'runContamination',
      'toolVersions',
      'writeEvidence',
      'writeChecksums',
      'drain'
    ])
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('sets every non-signing output on a successful pass', async () => {
    await run()

    expect(core.setOutput).toHaveBeenCalledWith(
      'disk-digest',
      `sha256:${'a'.repeat(64)}`
    )
    expect(outputNames()).toEqual([
      'disk-digest',
      'checksums-path',
      'sbom-path',
      'vulnerability-report-path',
      'validation-report-path',
      'validation-predicate-path'
    ])
    // No attestation outputs and no signing in signer:none.
    expect(outputNames()).not.toContain('attestation-bundle-path')
    expect(outputNames()).not.toContain('attestation-url')
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('skips metadata and the manifest digest when their inputs are unset', async () => {
    await run()
    expect(validateMetadata).not.toHaveBeenCalled()
    expect(sha256File).not.toHaveBeenCalled()
  })

  it('drains the cleanup registry on a successful run', async () => {
    await run()
    expect(drain).toHaveBeenCalledTimes(1)
    expect(calls[calls.length - 1]).toBe('drain')
  })

  it('drains the cleanup registry when a mid-pipeline stage throws', async () => {
    inspectFilesystem.mockImplementationOnce(async () => {
      throw new Error('guestmount failed: appliance kernel unreadable')
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'guestmount failed: appliance kernel unreadable'
    )
    // Later stages never ran, but cleanup still drained.
    expect(generateSbom).not.toHaveBeenCalled()
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('writes complete evidence, sets outputs, then fails on an evidence-complete result:fail (threshold)', async () => {
    vulnResult = { ...vulnResult, thresholdExceeded: true }
    evidenceResult = 'fail'

    await run()

    // Evidence and checksums were written before the failure.
    expect(writeEvidence).toHaveBeenCalledTimes(1)
    expect(writeChecksums).toHaveBeenCalledTimes(1)
    // Outputs are still set.
    expect(outputNames()).toContain('validation-predicate-path')
    // The distinct, evidence-complete failure message (not a fail-closed abort).
    expect(core.setFailed).toHaveBeenCalledTimes(1)
    const msg = core.setFailed.mock.calls[0][0] as string
    expect(msg).toMatch(/complete evidence was written/)
    expect(msg).toMatch(/threshold/)
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('names failed contamination checks in the evidence-complete failure', async () => {
    evidenceResult = 'fail'
    runContamination.mockImplementationOnce(() => {
      calls.push('runContamination')
      return {
        checks: [
          {
            id: 'no-machine-id',
            title: 'Machine identity is cleared',
            status: 'fail',
            detail: 'present'
          }
        ],
        policy: { id: 'builtin/v1' }
      }
    })

    await run()

    const msg = core.setFailed.mock.calls[0][0] as string
    expect(msg).toMatch(/contamination check/)
    expect(msg).toMatch(/no-machine-id/)
  })

  it('does not invoke any signer and logs a skip notice for signer:none', async () => {
    await run()
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('signer is "none"')
    )
  })

  it('fails the run and still drains when parseInputs throws', async () => {
    parseInputs.mockImplementation(() => {
      throw new Error('disk-path is required but was not provided.')
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'disk-path is required but was not provided.'
    )
    expect(drain).toHaveBeenCalledTimes(1)
    expect(validateDisk).not.toHaveBeenCalled()
  })

  it('selects the cyclonedx SBOM basename for cyclonedx-json format', async () => {
    parseInputs.mockReturnValue(baseInputs({ sbomFormat: 'cyclonedx-json' }))

    await run()

    const sbomCall = generateSbom.mock.calls[0]
    expect(sbomCall[3]).toMatch(/sbom\.cyclonedx\.json$/)
  })
})
