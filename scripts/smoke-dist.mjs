// Smoke-test the committed action bundles by executing each one with Node and
// no inputs, exactly as the Actions runtime would launch it. A healthy bundle
// loads completely and fails with its own first input diagnostic; a bundle
// broken at load time (an unresolved module, a bad relative require such as
// tools.ts's package.json lookup from dist/sign/) crashes differently and
// fails here. This runs from the check-dist npm script, sequentially after the
// bundle rebuild — never from jest, because `moon check` runs the test and
// check-dist tasks concurrently and check-dist deletes dist/ mid-rebuild.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const bundles = [
  {
    name: 'main action (dist/index.js)',
    path: join(root, 'dist', 'index.js'),
    expected: 'disk-path is required but was not provided.'
  },
  {
    name: 'sign action (dist/sign/index.js)',
    path: join(root, 'dist', 'sign', 'index.js'),
    expected: 'signer is required but was not provided.'
  }
]

let failed = false
for (const bundle of bundles) {
  const result = spawnSync(process.execPath, [bundle.path], {
    encoding: 'utf8',
    timeout: 60_000
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const problems = []
  if (result.error) problems.push(`spawn failed: ${result.error.message}`)
  if (result.status !== 1) problems.push(`exit code ${result.status}, want 1`)
  if (!stdout.includes(`::error::${bundle.expected}`)) {
    problems.push(`stdout is missing "::error::${bundle.expected}"`)
  }
  if (stderr.trim().length > 0) {
    problems.push(`unexpected stderr output:\n${stderr}`)
  }
  if (problems.length > 0) {
    failed = true
    console.error(`FAIL ${bundle.name}`)
    for (const problem of problems) console.error(`  ${problem}`)
  } else {
    console.log(`ok ${bundle.name}`)
  }
}

process.exit(failed ? 1 : 0)
