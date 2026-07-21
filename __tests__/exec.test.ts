/**
 * Unit tests for src/exec.ts.
 *
 * '@actions/core' is mocked via the shared fixture (startGroup/endGroup are
 * observable) and '@actions/exec' getExecOutput is mocked so no real process is
 * spawned.
 */
import { jest } from '@jest/globals'
import type * as actionsExec from '@actions/exec'
import * as core from '../__fixtures__/core.js'

const getExecOutput = jest.fn<typeof actionsExec.getExecOutput>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/exec', () => ({ getExecOutput }))

const { exec } = await import('../src/exec.js')

describe('exec.ts', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  it('returns captured stdout/stderr/exitCode and groups the command line', async () => {
    getExecOutput.mockResolvedValue({
      stdout: 'out',
      stderr: 'err',
      exitCode: 0
    })

    const result = await exec('echo', ['hello', 'world'])

    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 })
    expect(core.startGroup).toHaveBeenCalledWith('echo hello world')
    expect(core.endGroup).toHaveBeenCalledTimes(1)
  })

  it('forwards options and always captures the exit code internally', async () => {
    getExecOutput.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const env = { PATH: '/usr/bin' }
    const input = Buffer.from('stdin')

    await exec('cat', [], { cwd: '/tmp', env, input, silent: true })

    expect(getExecOutput).toHaveBeenCalledWith('cat', [], {
      cwd: '/tmp',
      env,
      input,
      silent: true,
      ignoreReturnCode: true
    })
  })

  it('throws on a non-zero exit by default and still closes the group', async () => {
    getExecOutput.mockResolvedValue({
      stdout: '',
      stderr: 'boom detail',
      exitCode: 2
    })

    await expect(exec('false', ['x'])).rejects.toThrow(
      /Command failed with exit code 2: false x[\s\S]*boom detail/
    )
    expect(core.endGroup).toHaveBeenCalledTimes(1)
  })

  it('defaults args and opts and omits stderr detail when empty', async () => {
    getExecOutput.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 })

    await expect(exec('false')).rejects.toThrow(
      'Command failed with exit code 1: false'
    )
    expect(getExecOutput).toHaveBeenCalledWith('false', [], {
      cwd: undefined,
      env: undefined,
      input: undefined,
      silent: undefined,
      ignoreReturnCode: true
    })
  })

  it('returns a non-zero result without throwing when ignoreReturnCode is set', async () => {
    getExecOutput.mockResolvedValue({
      stdout: 'partial',
      stderr: '',
      exitCode: 3
    })

    const result = await exec('grype', ['scan'], { ignoreReturnCode: true })

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe('partial')
  })
})
