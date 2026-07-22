import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREDICATE_TYPE, STATEMENT_TYPE } from '../src/predicate.js'
import type { Statement } from '../src/predicate.js'
import {
  buildExternalStatements,
  buildGitHubActionsProvenance
} from '../src/sign/statements.js'

const DISK_SHA = 'a'.repeat(64)
const META_SHA = 'b'.repeat(64)
const SBOM_SHA = 'c'.repeat(64)
const ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'meigma/attest-vm-image',
  GITHUB_REF: 'refs/heads/feat/cosign-key-signing',
  GITHUB_SHA: 'd'.repeat(40),
  GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY_ID: '5678',
  GITHUB_REPOSITORY_OWNER_ID: '9012',
  GITHUB_WORKFLOW_REF:
    'meigma/attest-vm-image/.github/workflows/integration.yml@refs/heads/feat/cosign-key-signing',
  RUNNER_ENVIRONMENT: 'github-hosted'
}

describe('external statements', () => {
  let dir: string
  let sbomPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-statements-'))
    sbomPath = join(dir, 'sbom.spdx.json')
    writeFileSync(
      sbomPath,
      JSON.stringify({ spdxVersion: 'SPDX-2.3', name: 'test-sbom' })
    )
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('matches the GitHub Actions SLSA v1 predicate shape from environment only', () => {
    expect(buildGitHubActionsProvenance(ENV)).toEqual({
      buildDefinition: {
        buildType: 'https://actions.github.io/buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: ENV.GITHUB_REF,
            repository: 'https://github.com/meigma/attest-vm-image',
            path: '.github/workflows/integration.yml'
          }
        },
        internalParameters: {
          github: {
            event_name: 'push',
            repository_id: '5678',
            repository_owner_id: '9012',
            runner_environment: 'github-hosted'
          }
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/meigma/attest-vm-image@refs/heads/feat/cosign-key-signing',
            digest: { gitCommit: ENV.GITHUB_SHA }
          }
        ]
      },
      runDetails: {
        builder: {
          id: `https://github.com/${ENV.GITHUB_WORKFLOW_REF}`
        },
        metadata: {
          invocationId:
            'https://github.com/meigma/attest-vm-image/actions/runs/1234/attempts/2'
        }
      }
    })
  })

  it('fails closed when provenance environment is incomplete', () => {
    expect(() =>
      buildGitHubActionsProvenance({ ...ENV, GITHUB_SHA: '' })
    ).toThrow(/missing GITHUB_SHA/)
  })

  it('builds the stable provenance, SBOM, and validation statements', async () => {
    const validation = {
      _type: STATEMENT_TYPE,
      subject: [{ name: 'disk.qcow2', digest: { sha256: DISK_SHA } }],
      predicateType: PREDICATE_TYPE,
      predicate: { schemaVersion: '1', result: 'pass' }
    } as unknown as Statement

    const statements = await buildExternalStatements(
      {
        disk: { path: join(dir, 'disk.qcow2'), sha256: DISK_SHA },
        metadata: { path: join(dir, 'metadata.tar.gz'), sha256: META_SHA },
        sbom: {
          path: sbomPath,
          sha256: SBOM_SHA,
          format: 'spdx-json'
        },
        statement: validation,
        outputDir: dir
      },
      ENV
    )

    expect(
      statements.map(({ role, filename, predicateType }) => ({
        role,
        filename,
        predicateType
      }))
    ).toEqual([
      {
        role: 'provenance-attestation',
        filename: 'provenance.sigstore.json',
        predicateType: 'https://slsa.dev/provenance/v1'
      },
      {
        role: 'sbom-attestation',
        filename: 'sbom.sigstore.json',
        predicateType: 'https://spdx.dev/Document/v2.3'
      },
      {
        role: 'validation-attestation',
        filename: 'validation.sigstore.json',
        predicateType: PREDICATE_TYPE
      }
    ])
    expect(statements[0].statement.subject).toEqual([
      { name: 'disk.qcow2', digest: { sha256: DISK_SHA } },
      { name: 'metadata.tar.gz', digest: { sha256: META_SHA } }
    ])
    expect(statements[1].statement.subject).toHaveLength(1)
    expect(statements[1].statement.predicate).toEqual({
      spdxVersion: 'SPDX-2.3',
      name: 'test-sbom'
    })
    expect(statements[2].statement).toBe(validation)
  })
})
