/**
 * Guard for the sigstore override in package.json.
 *
 * package.json overrides force @sigstore/sign@^5 / @sigstore/bundle@^5 under
 * @actions/attest (which declares ^3.x) so the dependency tree resolves the
 * patched @sigstore/core@^4.0.1 (GHSA-jfc7-64v2-mr8c). This asserts the
 * lockfile actually resolved the patched versions, so a regression (e.g. an
 * @actions/attest bump re-pinning sign@3 and dropping the override silently)
 * fails here instead of reintroducing the vulnerable core.
 *
 * Runtime API compatibility of the overridden majors is exercised where it is
 * real: rollup resolves @actions/attest's named sigstore imports at bundle
 * time, and the signer integration job runs the signing path end to end.
 */
import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'

interface LockPackage {
  version?: string
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, LockPackage>
}

const resolved = (name: string): string => {
  const entry = Object.entries(lock.packages).find(([path]) =>
    path.endsWith(`node_modules/${name}`)
  )
  expect(entry).toBeDefined()
  return (entry as [string, LockPackage])[1].version ?? ''
}

describe('sigstore override in package-lock.json', () => {
  it('resolves @sigstore/core to the patched major (>= 4)', () => {
    const major = Number(resolved('@sigstore/core').split('.')[0])
    expect(major).toBeGreaterThanOrEqual(4)
  })

  it('resolves @sigstore/sign and @sigstore/bundle to the overridden majors', () => {
    expect(
      Number(resolved('@sigstore/sign').split('.')[0])
    ).toBeGreaterThanOrEqual(5)
    expect(
      Number(resolved('@sigstore/bundle').split('.')[0])
    ).toBeGreaterThanOrEqual(5)
  })
})
