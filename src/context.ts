import * as core from '@actions/core'

/** GitHub Actions workflow context consumed by the predicate assembler. */
export interface WorkflowContext {
  repository: string
  ref: string
  sha: string
  runId: string
  runAttempt: string
  eventName: string
  actor: string
}

// Field-to-environment-variable mapping, in predicate field order.
const FIELDS: ReadonlyArray<readonly [keyof WorkflowContext, string]> = [
  ['repository', 'GITHUB_REPOSITORY'],
  ['ref', 'GITHUB_REF'],
  ['sha', 'GITHUB_SHA'],
  ['runId', 'GITHUB_RUN_ID'],
  ['runAttempt', 'GITHUB_RUN_ATTEMPT'],
  ['eventName', 'GITHUB_EVENT_NAME'],
  ['actor', 'GITHUB_ACTOR']
]

/**
 * Capture the workflow context from the standard `GITHUB_*` environment
 * variables into a typed object. A missing or empty variable becomes an empty
 * string with a `core.warning` naming it — the predicate needs the full object
 * shape regardless, so capture never fails.
 */
export function workflowContext(): WorkflowContext {
  const context = {} as WorkflowContext
  for (const [field, envVar] of FIELDS) {
    const value = process.env[envVar]
    if (value === undefined || value === '') {
      core.warning(
        `Environment variable ${envVar} is not set; recording an empty ${field}.`
      )
      context[field] = ''
    } else {
      context[field] = value
    }
  }
  return context
}
