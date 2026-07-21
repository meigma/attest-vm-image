/**
 * Unit tests for src/predicate.ts.
 *
 * buildStatement is pure, so it is exercised directly from a fully-populated
 * fixture state (snapshot) plus a result-fail variant. writeEvidence writes to a
 * real temp directory (node:fs is real) and is checked for the report's extra
 * `incusMetadata.properties` field. A separate test reads the on-disk JSON
 * Schema and asserts its `$id` equals PREDICATE_TYPE.
 */
import { jest } from '@jest/globals'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const {
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  buildStatement,
  buildReport,
  writeEvidence
} = await import('../src/predicate.js')
type PredicateState = import('../src/predicate.js').PredicateState

// A fully-populated state with every optional field present, so the snapshot
// covers the maximal predicate shape.
function fullState(): PredicateState {
  return {
    diskPath: 'build/output/disk.qcow2',
    disk: {
      sha256: 'a'.repeat(64),
      sizeBytes: 536870912,
      virtualSize: 2147483648,
      actualSize: 268435456,
      compat: '1.1'
    },
    metadata: {
      sha256: 'b'.repeat(64),
      properties: { os: 'Ubuntu', release: 'jammy', variant: 'runner' }
    },
    buildManifest: { sha256: 'c'.repeat(64) },
    tools: [
      { name: 'syft', version: '1.48.0' },
      { name: 'grype', version: '0.116.0' },
      { name: 'qemu-utils', version: '1:8.2.2+ds-0ubuntu1' },
      { name: 'libguestfs-tools', version: '1:1.52.0-1ubuntu1' },
      { name: 'attest-vm-image', version: '0.1.0' }
    ],
    fsView: {
      operatingSystem: {
        id: 'ubuntu',
        versionId: '22.04',
        prettyName: 'Ubuntu 22.04.4 LTS',
        arch: 'x86_64'
      },
      packages: [
        { name: 'openssl', version: '3.0.2-0ubuntu1' },
        { name: 'zlib1g', version: '1:1.2.11.dfsg-2ubuntu9' }
      ],
      mountPath: '/tmp/attest-mount-xxxx'
    },
    sbom: {
      path: '/evidence/sbom.spdx.json',
      format: 'spdx-json',
      sha256: 'd'.repeat(64)
    },
    vuln: {
      path: '/evidence/vulnerability-report.json',
      sha256: 'e'.repeat(64),
      scanner: { name: 'grype', version: '0.116.0' },
      dbVersion: 'schema v6.1.9, built 2026-07-19T01:23:45Z',
      summary: {
        critical: 0,
        high: 0,
        medium: 2,
        low: 1,
        negligible: 0,
        unknown: 0
      },
      thresholdExceeded: false
    },
    contamination: {
      checks: [
        {
          id: 'no-machine-id',
          title: 'Machine identity is cleared for regeneration',
          status: 'pass',
          detail: 'File is present but empty: /etc/machine-id'
        },
        {
          id: 'no-ssh-host-keys',
          title: 'Persisted SSH host keys are absent',
          status: 'pass',
          detail: 'No path matched glob: /etc/ssh/ssh_host_*_key*'
        }
      ],
      policy: { id: 'builtin/v1' }
    },
    threshold: 'high',
    workflow: {
      repository: 'meigma/attest-vm-image',
      ref: 'refs/heads/main',
      sha: '0123456789abcdef0123456789abcdef01234567',
      runId: '42',
      runAttempt: '1',
      eventName: 'push',
      actor: 'octocat'
    }
  }
}

describe('predicate.ts', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('buildStatement', () => {
    it('assembles the full statement from a populated state (snapshot)', () => {
      expect(buildStatement(fullState())).toMatchSnapshot()
    })

    it('uses the disk basename for the subject and artifact name', () => {
      const statement = buildStatement(fullState())
      expect(statement.subject).toEqual([
        { name: 'disk.qcow2', digest: { sha256: 'a'.repeat(64) } }
      ])
      expect(statement.predicate.artifact.name).toBe('disk.qcow2')
      expect(statement._type).toBe(STATEMENT_TYPE)
      expect(statement.predicateType).toBe(PREDICATE_TYPE)
    })

    it('flattens the vulnerability scanner to its name', () => {
      const statement = buildStatement(fullState())
      expect(statement.predicate.vulnerabilities.scanner).toBe('grype')
    })

    it('nulls incusMetadata and buildManifest when their inputs are absent', () => {
      const state = fullState()
      delete state.metadata
      delete state.buildManifest
      const statement = buildStatement(state)
      expect(statement.predicate.incusMetadata).toBeNull()
      expect(statement.predicate.buildManifest).toBeNull()
    })

    it('carries only the metadata digest in the predicate (no properties)', () => {
      const statement = buildStatement(fullState())
      expect(statement.predicate.incusMetadata).toEqual({
        sha256: 'b'.repeat(64)
      })
    })

    describe('result computation', () => {
      it('is pass when no check fails and the threshold is not exceeded', () => {
        expect(buildStatement(fullState()).predicate.result).toBe('pass')
      })

      it('is fail when any contamination check fails (snapshot)', () => {
        const state = fullState()
        state.contamination.checks[0] = {
          id: 'no-machine-id',
          title: 'Machine identity is cleared for regeneration',
          status: 'fail',
          detail: 'File is present and non-empty: /etc/machine-id'
        }
        const statement = buildStatement(state)
        expect(statement.predicate.result).toBe('fail')
        expect(statement).toMatchSnapshot()
      })

      it('is fail when the vulnerability threshold is exceeded', () => {
        const state = fullState()
        state.vuln.thresholdExceeded = true
        state.vuln.summary.high = 3
        expect(buildStatement(state).predicate.result).toBe('fail')
      })
    })
  })

  describe('buildReport', () => {
    it('adds incusMetadata.properties that the predicate omits', () => {
      const state = fullState()
      const report = buildReport(buildStatement(state), state)
      expect(report.incusMetadata).toEqual({
        sha256: 'b'.repeat(64),
        properties: { os: 'Ubuntu', release: 'jammy', variant: 'runner' }
      })
      expect(report.subject).toEqual(buildStatement(state).subject)
      expect(report.predicateType).toBe(PREDICATE_TYPE)
    })

    it('nulls report incusMetadata when no metadata was provided', () => {
      const state = fullState()
      delete state.metadata
      const report = buildReport(buildStatement(state), state)
      expect(report.incusMetadata).toBeNull()
    })
  })

  describe('writeEvidence', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'attest-predicate-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes both documents; the report carries properties, the predicate does not', async () => {
      const predicatePath = join(dir, 'validation-predicate.json')
      const reportPath = join(dir, 'validation-report.json')
      const statement = await writeEvidence(fullState(), {
        predicatePath,
        reportPath
      })

      const writtenPredicate = JSON.parse(readFileSync(predicatePath, 'utf8'))
      const writtenReport = JSON.parse(readFileSync(reportPath, 'utf8'))

      expect(writtenPredicate).toEqual(statement)
      expect(writtenPredicate.predicate.incusMetadata).toEqual({
        sha256: 'b'.repeat(64)
      })
      expect(writtenReport.incusMetadata.properties).toEqual({
        os: 'Ubuntu',
        release: 'jammy',
        variant: 'runner'
      })
    })
  })

  describe('PREDICATE_TYPE matches the published JSON Schema $id', () => {
    it('string-equals the schema file $id', () => {
      const schema = JSON.parse(
        readFileSync(
          'docs/predicate/vm-image-validation-v1.schema.json',
          'utf8'
        )
      )
      expect(schema.$id).toBe(PREDICATE_TYPE)
    })
  })
})
