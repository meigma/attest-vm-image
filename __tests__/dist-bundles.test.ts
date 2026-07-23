/**
 * Smoke tests for the committed action bundles. Each bundle is executed with
 * Node and no inputs, exactly as the Actions runtime would launch it. A healthy
 * bundle loads completely and fails with its own first input diagnostic; a
 * bundle broken at load time (an unresolved module, a bad relative require such
 * as tools.ts's package.json lookup from dist/sign/) crashes with a different
 * error and fails these assertions. `check-dist` separately guarantees the
 * committed bundles match the current sources.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const BUNDLES = [
  {
    name: 'main action (dist/index.js)',
    path: join(ROOT, 'dist', 'index.js'),
    expected: 'disk-path is required but was not provided.'
  },
  {
    name: 'sign action (dist/sign/index.js)',
    path: join(ROOT, 'dist', 'sign', 'index.js'),
    expected: 'signer is required but was not provided.'
  }
] as const

describe.each(BUNDLES)('$name', ({ path, expected }) => {
  it('loads and fails with its own input diagnostic', () => {
    expect(existsSync(path)).toBe(true)

    const result = spawnSync(process.execPath, [path], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STATE: '' }
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`::error::${expected}`)
    // A load-time crash surfaces on stderr before run() ever executes.
    expect(result.stderr).not.toContain('MODULE_NOT_FOUND')
  })
})
