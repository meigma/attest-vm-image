/**
 * Unit tests for src/context.ts.
 *
 * '@actions/core' is mocked via the shared fixture so warning() is observable,
 * and the relevant GITHUB_* environment variables are saved and restored around
 * each test.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { workflowContext } = await import('../src/context.js')

const ENV_VARS = [
  'GITHUB_REPOSITORY',
  'GITHUB_REF',
  'GITHUB_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_EVENT_NAME',
  'GITHUB_ACTOR'
] as const

describe('context.ts', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_VARS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    jest.resetAllMocks()
  })

  it('maps a full environment into a typed object without warnings', () => {
    process.env.GITHUB_REPOSITORY = 'meigma/attest-vm-image'
    process.env.GITHUB_REF = 'refs/heads/main'
    process.env.GITHUB_SHA = 'deadbeef'
    process.env.GITHUB_RUN_ID = '42'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.GITHUB_EVENT_NAME = 'push'
    process.env.GITHUB_ACTOR = 'octocat'

    expect(workflowContext()).toEqual({
      repository: 'meigma/attest-vm-image',
      ref: 'refs/heads/main',
      sha: 'deadbeef',
      runId: '42',
      runAttempt: '1',
      eventName: 'push',
      actor: 'octocat'
    })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('records an empty string and warns for each missing variable', () => {
    process.env.GITHUB_REPOSITORY = 'meigma/attest-vm-image'
    // The remaining six variables are left unset.

    const context = workflowContext()

    expect(context.repository).toBe('meigma/attest-vm-image')
    expect(context.ref).toBe('')
    expect(context.actor).toBe('')
    expect(core.warning).toHaveBeenCalledTimes(6)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_REF')
    )
  })

  it('treats an empty-string variable as missing', () => {
    process.env.GITHUB_REPOSITORY = ''
    process.env.GITHUB_REF = 'refs/heads/main'
    process.env.GITHUB_SHA = 'deadbeef'
    process.env.GITHUB_RUN_ID = '42'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.GITHUB_EVENT_NAME = 'push'
    process.env.GITHUB_ACTOR = 'octocat'

    const context = workflowContext()

    expect(context.repository).toBe('')
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_REPOSITORY')
    )
  })
})
