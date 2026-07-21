/**
 * Unit tests for src/hash.ts.
 *
 * No mocking: these exercise the real crypto/stream implementation against the
 * canonical NIST "abc" SHA-256 test vector, writing a real temp file for the
 * streaming path.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Buffer, sha256File } from '../src/hash.js'

// sha256("abc"), the canonical FIPS 180-2 example.
const ABC_DIGEST =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

describe('hash.ts', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-hash-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sha256Buffer matches the known "abc" vector in lowercase hex', () => {
    expect(sha256Buffer(Buffer.from('abc'))).toBe(ABC_DIGEST)
  })

  it('sha256File matches the known "abc" vector by streaming', async () => {
    const file = join(dir, 'abc.txt')
    writeFileSync(file, 'abc')
    expect(await sha256File(file)).toBe(ABC_DIGEST)
  })

  it('sha256Buffer and sha256File agree on the same bytes', async () => {
    const bytes = Buffer.from('the quick brown fox')
    const file = join(dir, 'fox.txt')
    writeFileSync(file, bytes)
    expect(await sha256File(file)).toBe(sha256Buffer(bytes))
  })

  it('sha256File rejects when the file cannot be read', async () => {
    await expect(sha256File(join(dir, 'does-not-exist'))).rejects.toThrow()
  })
})
