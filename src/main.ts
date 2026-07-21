import * as core from '@actions/core'
import { parseInputs } from './inputs.js'

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const inputs = parseInputs()

    core.info(
      `attest-vm-image: inputs parsed for disk-path "${inputs.diskPath}" ` +
        `(signer: ${inputs.signer}). The evidence pipeline is not yet ` +
        `implemented; this stage lands in a later phase.`
    )
  } catch (error) {
    // Fail the workflow run if an error occurs.
    if (error instanceof Error) core.setFailed(error.message)
    else core.setFailed(String(error))
  }
}
