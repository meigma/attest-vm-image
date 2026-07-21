import * as core from '@actions/core'
import * as actionsExec from '@actions/exec'

/** Captured result of a child-process invocation. */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Options for {@link exec}; a focused subset of `@actions/exec` options. */
export interface ExecOptions {
  /** Working directory; defaults to the current process directory. */
  cwd?: string
  /** Environment variables; defaults to the current process environment. */
  env?: Record<string, string>
  /** Data written to the child's stdin. */
  input?: Buffer
  /** Suppress streaming the child's output to the live console. */
  silent?: boolean
  /**
   * When true, a non-zero exit is returned to the caller instead of throwing.
   * Defaults to false, so a non-zero exit throws.
   */
  ignoreReturnCode?: boolean
}

/**
 * Run a command through `@actions/exec`, capturing stdout, stderr, and the exit
 * code. Every invocation is wrapped in a `core.startGroup`/`endGroup` labelled
 * with the full command line so each tool call is a foldable section in the
 * workflow log. By default a non-zero exit throws; pass
 * `opts.ignoreReturnCode` to receive the result instead.
 */
export async function exec(
  cmd: string,
  args: string[] = [],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const label = [cmd, ...args].join(' ')
  core.startGroup(label)
  try {
    const result = await actionsExec.getExecOutput(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      input: opts.input,
      silent: opts.silent,
      // Always capture the code so cleanup (endGroup) runs and the thrown
      // error can name the command; the throw decision is made below.
      ignoreReturnCode: true
    })

    if (!opts.ignoreReturnCode && result.exitCode !== 0) {
      const detail = result.stderr.trim()
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${label}` +
          (detail ? `\n${detail}` : '')
      )
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    }
  } finally {
    core.endGroup()
  }
}
