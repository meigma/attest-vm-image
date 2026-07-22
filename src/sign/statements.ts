import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SbomFormat } from '../inputs.js'
import { PREDICATE_TYPE, STATEMENT_TYPE } from '../predicate.js'
import type { StatementSubject } from '../predicate.js'
import type { SignBundle, SignContext } from './types.js'

export const SLSA_PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1'
export const BUNDLE_DIR = 'attestations'

export interface ExternalStatement {
  role: SignBundle['role']
  filename: string
  predicateType: string
  statement: {
    _type: typeof STATEMENT_TYPE
    subject: StatementSubject[]
    predicateType: string
    predicate: object
  }
}

const REQUIRED_PROVENANCE_ENV = [
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_REF',
  'GITHUB_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_EVENT_NAME',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_WORKFLOW_REF',
  'RUNNER_ENVIRONMENT'
] as const

export async function buildExternalStatements(
  ctx: SignContext,
  env: NodeJS.ProcessEnv = process.env
): Promise<ExternalStatement[]> {
  const diskSubject = subject(ctx.disk.path, ctx.disk.sha256)
  const provenanceSubjects = [diskSubject]
  if (ctx.metadata) {
    provenanceSubjects.push(subject(ctx.metadata.path, ctx.metadata.sha256))
  }

  const sbomPredicate = JSON.parse(
    await fs.promises.readFile(ctx.sbom.path, 'utf8')
  ) as object
  const sbomType = sbomPredicateType(ctx.sbom.format, sbomPredicate)

  return [
    {
      role: 'provenance-attestation',
      filename: 'provenance.sigstore.json',
      predicateType: SLSA_PROVENANCE_TYPE,
      statement: statement(
        provenanceSubjects,
        SLSA_PROVENANCE_TYPE,
        buildGitHubActionsProvenance(env)
      )
    },
    {
      role: 'sbom-attestation',
      filename: 'sbom.sigstore.json',
      predicateType: sbomType,
      statement: statement([diskSubject], sbomType, sbomPredicate)
    },
    {
      role: 'validation-attestation',
      filename: 'validation.sigstore.json',
      predicateType: PREDICATE_TYPE,
      statement: ctx.statement
    }
  ]
}

export function sbomPredicateType(format: SbomFormat, doc: object): string {
  if (format === 'cyclonedx-json') return 'https://cyclonedx.org/bom'
  const raw = (doc as { spdxVersion?: unknown }).spdxVersion
  const match = typeof raw === 'string' ? /^SPDX-(\d+\.\d+)$/.exec(raw) : null
  return `https://spdx.dev/Document/v${match ? match[1] : '2.3'}`
}

export function buildGitHubActionsProvenance(
  env: NodeJS.ProcessEnv = process.env
): object {
  const missing = REQUIRED_PROVENANCE_ENV.filter((name) => !env[name])
  if (missing.length > 0) {
    throw new Error(
      `external signing requires GitHub Actions provenance environment variables: missing ${missing.join(', ')}.`
    )
  }

  const value = (name: (typeof REQUIRED_PROVENANCE_ENV)[number]): string =>
    env[name] as string
  const server = value('GITHUB_SERVER_URL')
  const repository = value('GITHUB_REPOSITORY')
  const workflowRef = value('GITHUB_WORKFLOW_REF')
  const workflowPath = workflowRef.replace(`${repository}/`, '').split('@')[0]

  return {
    buildDefinition: {
      buildType: 'https://actions.github.io/buildtypes/workflow/v1',
      externalParameters: {
        workflow: {
          ref: value('GITHUB_REF'),
          repository: `${server}/${repository}`,
          path: workflowPath
        }
      },
      internalParameters: {
        github: {
          event_name: value('GITHUB_EVENT_NAME'),
          repository_id: value('GITHUB_REPOSITORY_ID'),
          repository_owner_id: value('GITHUB_REPOSITORY_OWNER_ID'),
          runner_environment: value('RUNNER_ENVIRONMENT')
        }
      },
      resolvedDependencies: [
        {
          uri: `git+${server}/${repository}@${value('GITHUB_REF')}`,
          digest: { gitCommit: value('GITHUB_SHA') }
        }
      ]
    },
    runDetails: {
      builder: { id: `${server}/${workflowRef}` },
      metadata: {
        invocationId: `${server}/${repository}/actions/runs/${value('GITHUB_RUN_ID')}/attempts/${value('GITHUB_RUN_ATTEMPT')}`
      }
    }
  }
}

function subject(file: string, sha256: string): StatementSubject {
  return { name: path.basename(file), digest: { sha256 } }
}

function statement(
  subjects: StatementSubject[],
  predicateType: string,
  predicate: object
): ExternalStatement['statement'] {
  return {
    _type: STATEMENT_TYPE,
    subject: subjects,
    predicateType,
    predicate
  }
}
