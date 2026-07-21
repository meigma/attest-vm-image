/**
 * Smoke test for the @actions/attest runtime dependency.
 *
 * package.json overrides force @sigstore/sign@^5 / @sigstore/bundle@^5 under
 * @actions/attest (which declares ^3.x) to resolve the patched
 * @sigstore/core@^4.0.1. @actions/attest binds five named exports from
 * @sigstore/sign and one from @sigstore/bundle at module load, so importing it
 * here proves the overridden majors still satisfy that surface — an
 * incompatible bump fails this test instead of the action's signing path.
 */
import { describe, expect, it } from '@jest/globals'

describe('@actions/attest with overridden sigstore dependencies', () => {
  it('imports and exposes the signing entry points', async () => {
    const mod = await import('@actions/attest')

    expect(typeof mod.attest).toBe('function')
    expect(typeof mod.attestProvenance).toBe('function')
  })
})
