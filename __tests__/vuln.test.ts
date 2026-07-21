/**
 * Unit tests for src/vuln.ts.
 *
 * The exec wrapper and tool resolver are mocked so no real Grype runs; report
 * bytes come from __fixtures__/samples or inline JSON. The hash helper and
 * node:fs are REAL: the report is written to a real temp file and re-hashed.
 */
import { jest } from '@jest/globals'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../__fixtures__/core.js'
import { exec } from '../__fixtures__/exec.js'

const ensureBinary = jest.fn<() => Promise<string>>()

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('../src/exec.js', () => ({ exec }))
jest.unstable_mockModule('../src/tools.js', () => ({ ensureBinary }))

const { scanVulnerabilities, severityAtOrAbove } =
  await import('../src/vuln.js')
const { sha256File } = await import('../src/hash.js')

const sample = (name: string): string =>
  readFileSync(join('__fixtures__/samples', name), 'utf8')

const CLEAN = sample('grype-clean.json')
const FINDINGS = sample('grype-with-findings.json')

const SBOM = '/evidence/sbom.spdx.json'

function stdout(body: string, exitCode = 0): void {
  exec.mockResolvedValue({ stdout: body, stderr: '', exitCode })
}

describe('vuln.ts', () => {
  let dir: string
  let out: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attest-vuln-'))
    out = join(dir, 'vulnerability-report.json')
    ensureBinary.mockResolvedValue('/opt/grype')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    jest.resetAllMocks()
  })

  describe('severityAtOrAbove comparator', () => {
    it.each([
      ['critical', ['critical']],
      ['high', ['critical', 'high']],
      ['none', []]
    ] as const)('%s -> %j', (threshold, expected) => {
      expect(severityAtOrAbove(threshold)).toEqual(expected)
    })
  })

  describe('thresholdExceeded across summary shapes', () => {
    // Each row: a grype doc, a threshold, and whether it should breach.
    const critOnly = JSON.stringify({
      matches: [{ vulnerability: { severity: 'critical' } }],
      descriptor: { name: 'grype', version: '1', db: {} }
    })
    const highOnly = JSON.stringify({
      matches: [{ vulnerability: { severity: 'high' } }],
      descriptor: { name: 'grype', version: '1', db: {} }
    })
    const medOnly = JSON.stringify({
      matches: [{ vulnerability: { severity: 'medium' } }],
      descriptor: { name: 'grype', version: '1', db: {} }
    })

    it.each([
      ['critical', critOnly, true],
      ['critical', highOnly, false],
      ['critical', medOnly, false],
      ['high', critOnly, true],
      ['high', highOnly, true],
      ['high', medOnly, false],
      ['none', critOnly, false],
      ['none', highOnly, false],
      ['none', medOnly, false]
    ] as const)(
      'threshold %s over %#-> %s',
      async (threshold, body, expected) => {
        stdout(body)
        const result = await scanVulnerabilities(SBOM, threshold, out)
        expect(result.thresholdExceeded).toBe(expected)
      }
    )
  })

  it('throws and writes nothing on a non-zero grype exit (empty stderr)', async () => {
    stdout('partial', 1)
    await expect(scanVulnerabilities(SBOM, 'high', out)).rejects.toThrow(
      /Grype vulnerability scan failed \(exit code 1\)/
    )
    expect(existsSync(out)).toBe(false)
  })

  it('appends stderr detail to a non-zero grype exit message', async () => {
    exec.mockResolvedValue({
      stdout: '',
      stderr: 'db load failed',
      exitCode: 1
    })
    await expect(scanVulnerabilities(SBOM, 'high', out)).rejects.toThrow(
      /exit code 1\)[\s\S]*db load failed/
    )
  })

  it('throws and writes nothing on empty grype output', async () => {
    stdout('   \n')
    await expect(scanVulnerabilities(SBOM, 'high', out)).rejects.toThrow(
      /produced no output/
    )
    expect(existsSync(out)).toBe(false)
  })

  it('throws and writes nothing on unparseable grype output', async () => {
    stdout('{not json')
    await expect(scanVulnerabilities(SBOM, 'high', out)).rejects.toThrow(
      /unparseable output/
    )
    expect(existsSync(out)).toBe(false)
  })

  it('returns thresholdExceeded true for findings over threshold WITHOUT throwing', async () => {
    stdout(FINDINGS)
    const result = await scanVulnerabilities(SBOM, 'high', out)
    expect(result.thresholdExceeded).toBe(true)
    expect(existsSync(out)).toBe(true)
  })

  it('tallies severities case-insensitively and buckets unexpected ones as unknown', async () => {
    stdout(FINDINGS)
    const result = await scanVulnerabilities(SBOM, 'none', out)
    expect(result.summary).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
      low: 0,
      negligible: 1,
      unknown: 1
    })
  })

  it('counts a match with no vulnerability object as unknown', async () => {
    stdout(
      JSON.stringify({
        matches: [{}, { vulnerability: {} }],
        descriptor: { name: 'grype', version: '1', db: {} }
      })
    )
    const result = await scanVulnerabilities(SBOM, 'none', out)
    expect(result.summary.unknown).toBe(2)
  })

  it('reports a clean scan with an all-zero summary and no breach', async () => {
    stdout(CLEAN)
    const result = await scanVulnerabilities(SBOM, 'critical', out)
    expect(result.summary).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      negligible: 0,
      unknown: 0
    })
    expect(result.thresholdExceeded).toBe(false)
    expect(result.scanner).toEqual({ name: 'grype', version: '0.116.0' })
    expect(result.dbVersion).toBe('schema v6.1.9, built 2026-07-19T01:23:45Z')
  })

  it('returns a sha256 that re-hashes the written report', async () => {
    stdout(FINDINGS)
    const result = await scanVulnerabilities(SBOM, 'high', out)
    expect(result.sha256).toBe(await sha256File(out))
    expect(readFileSync(out, 'utf8')).toBe(FINDINGS)
  })

  it('sets GRYPE_DB_CACHE_DIR only when a cache dir is provided', async () => {
    stdout(CLEAN)
    await scanVulnerabilities(SBOM, 'high', out, '/seed/grype-db')
    expect(exec).toHaveBeenCalledWith(
      join('/opt/grype', 'grype'),
      [`sbom:${SBOM}`, '-o', 'json'],
      expect.objectContaining({
        env: expect.objectContaining({ GRYPE_DB_CACHE_DIR: '/seed/grype-db' }),
        ignoreReturnCode: true
      })
    )
  })

  it('omits GRYPE_DB_CACHE_DIR when no cache dir is provided', async () => {
    stdout(CLEAN)
    await scanVulnerabilities(SBOM, 'high', out)
    const call = exec.mock.calls[0]
    const env = (call[2] as { env: Record<string, string> }).env
    expect(env.GRYPE_DB_CACHE_DIR).toBeUndefined()
  })

  it('resolves grype via ensureBinary', async () => {
    stdout(CLEAN)
    await scanVulnerabilities(SBOM, 'high', out)
    expect(ensureBinary).toHaveBeenCalledWith('grype')
  })

  describe('defensive db version extraction', () => {
    it.each([
      [
        'nested status shape',
        { status: { schemaVersion: 6, built: '2026-01-01T00:00:00Z' } },
        'schema 6, built 2026-01-01T00:00:00Z'
      ],
      ['empty db object', {}, 'unknown'],
      ['schema only', { schemaVersion: 7 }, 'schema 7'],
      [
        'built only',
        { built: '2026-02-02T00:00:00Z' },
        'built 2026-02-02T00:00:00Z'
      ]
    ] as const)('%s', async (_name, db, expected) => {
      stdout(
        JSON.stringify({
          matches: [],
          descriptor: { name: 'grype', version: '1', db }
        })
      )
      const result = await scanVulnerabilities(SBOM, 'high', out)
      expect(result.dbVersion).toBe(expected)
    })

    it('defaults scanner, db, and summary when the report is a bare object', async () => {
      stdout('{}')
      const result = await scanVulnerabilities(SBOM, 'high', out)
      expect(result.scanner).toEqual({ name: '', version: '' })
      expect(result.dbVersion).toBe('unknown')
      expect(result.summary.unknown).toBe(0)
      expect(result.thresholdExceeded).toBe(false)
    })

    it('renders unknown when the descriptor omits db entirely', async () => {
      stdout(JSON.stringify({ matches: [], descriptor: { name: 'grype' } }))
      const result = await scanVulnerabilities(SBOM, 'high', out)
      expect(result.dbVersion).toBe('unknown')
      expect(result.scanner).toEqual({ name: 'grype', version: '' })
    })
  })
})
