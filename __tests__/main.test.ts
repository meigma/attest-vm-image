/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * To mock dependencies in ESM, fixtures export mock functions and objects. The
 * core module is mocked here so the real '@actions/core' is never imported, and
 * '../src/inputs.js' is mocked so parseInputs behavior is controlled per test.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import type { Inputs } from '../src/inputs.js'

const parseInputs = jest.fn<() => Inputs>()

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/inputs.js', () => ({ parseInputs }))

// The module being tested is imported dynamically so the mocks are used in
// place of the actual dependencies.
const { run } = await import('../src/main.js')

const sampleInputs: Inputs = {
  diskPath: 'disk.qcow2',
  outputDirectory: './evidence',
  sbomFormat: 'spdx-json',
  failOnSeverity: 'high',
  signer: 'none'
}

describe('main.ts', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  it('parses inputs and logs a not-yet-implemented notice', async () => {
    parseInputs.mockReturnValue(sampleInputs)

    await run()

    expect(parseInputs).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledTimes(1)
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('not yet'))
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails the run when parseInputs throws', async () => {
    parseInputs.mockImplementation(() => {
      throw new Error('disk-path is required but was not provided.')
    })

    await run()

    expect(core.setFailed).toHaveBeenNthCalledWith(
      1,
      'disk-path is required but was not provided.'
    )
    expect(core.info).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error thrown by parseInputs', async () => {
    parseInputs.mockImplementation(() => {
      throw 'boom'
    })

    await run()

    expect(core.setFailed).toHaveBeenNthCalledWith(1, 'boom')
    expect(core.info).not.toHaveBeenCalled()
  })
})
