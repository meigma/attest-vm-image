/**
 * Unit tests for src/contamination.ts.
 *
 * Nothing external is mocked: matchers are evaluated against a real mkdtemp'd
 * fake mount, and loadPolicy reads real temp policy files and hashes them with
 * the real hash helper. Symlinks are created on the real filesystem to prove the
 * walk does not follow them out of the mount.
 */
import { jest } from '@jest/globals'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BUILTIN_POLICY,
  loadPolicy,
  runContamination
} from '../src/contamination.js'
import { sha256File } from '../src/hash.js'
import type { FsView } from '../src/inspect.js'

const asFsView = (mountPath: string): FsView =>
  ({ mountPath }) as unknown as FsView

describe('contamination.ts', () => {
  let mount: string

  const write = (rel: string, body = 'x'): void => {
    const abs = join(mount, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }

  beforeEach(() => {
    mount = mkdtempSync(join(tmpdir(), 'attest-mount-'))
  })

  afterEach(() => {
    rmSync(mount, { recursive: true, force: true })
    jest.resetAllMocks()
  })

  describe('BUILTIN_POLICY evaluation', () => {
    // Populate one file per built-in rule so a fully-contaminated fake root
    // fails every rule at once.
    function contaminateEverything(): void {
      write('home/runner/actions-runner/.credentials')
      write('home/runner/actions-runner/.runner')
      write('root/.ssh/id_rsa')
      write('home/user/deep/key.pem')
      write('etc/ssh/ssh_host_rsa_key')
      write('etc/machine-id', 'b1a2c3\n')
      write('var/lib/dbus/machine-id')
      write('var/lib/cloud/instance')
      write('var/lib/cloud/instances/i-123/obj.pkl')
      write('etc/apt/auth.conf')
      write('etc/apt/auth.conf.d/00creds')
      write('root/.netrc')
      write('tmp/leftover.txt')
      write('root/.bash_history')
      write('etc/shadow', 'root:$6$abc$def:19000:0:99999:7:::\n')
    }

    it('fails every rule for a fully-contaminated root and covers every rule id', () => {
      contaminateEverything()

      const { checks, policy } = runContamination(asFsView(mount), {
        policy: BUILTIN_POLICY
      })

      const ids = checks.map((c) => c.id)
      expect(new Set(ids)).toEqual(
        new Set(BUILTIN_POLICY.rules.map((r) => r.id))
      )
      expect(checks.every((c) => c.status === 'fail')).toBe(true)
      expect(policy).toEqual({ id: 'builtin/v1' })
    })

    it('passes every rule for a clean root', () => {
      const { checks } = runContamination(asFsView(mount), {
        policy: BUILTIN_POLICY
      })
      expect(checks).toHaveLength(BUILTIN_POLICY.rules.length)
      expect(checks.every((c) => c.status === 'pass')).toBe(true)
    })

    it('does not flag systemd /tmp skeleton or PrivateTmp on a booted-but-clean root', () => {
      // A realistically-booted, otherwise-hygienic Ubuntu 24.04 /tmp: the
      // systemd-tmpfiles socket skeleton (directories, possibly with sockets
      // inside) plus a PrivateTmp sandbox left by a service that ran during
      // provisioning. None of these are build contamination.
      mkdirSync(join(mount, 'tmp/.X11-unix'), { recursive: true })
      write('tmp/.X11-unix/X0')
      mkdirSync(join(mount, 'tmp/.ICE-unix'), { recursive: true })
      mkdirSync(join(mount, 'tmp/.font-unix'), { recursive: true })
      mkdirSync(join(mount, 'tmp/.XIM-unix'), { recursive: true })
      mkdirSync(join(mount, 'tmp/.Test-unix'), { recursive: true })
      write('tmp/systemd-private-abc123-systemd-resolved.service-Xy7z/tmp/foo')

      const check = runContamination(asFsView(mount), {
        policy: BUILTIN_POLICY
      }).checks.find((c) => c.id === 'no-build-temp-files')

      expect(check?.status).toBe('pass')
    })

    it('still flags a genuine build leftover alongside the /tmp skeleton', () => {
      mkdirSync(join(mount, 'tmp/.X11-unix'), { recursive: true })
      write('tmp/build-artifact.tar')

      const check = runContamination(asFsView(mount), {
        policy: BUILTIN_POLICY
      }).checks.find((c) => c.id === 'no-build-temp-files')

      expect(check?.status).toBe('fail')
    })

    it('passes a non-empty-file rule when the file exists but is empty', () => {
      write('etc/machine-id', '')

      const check = runContamination(asFsView(mount), {
        policy: BUILTIN_POLICY
      }).checks.find((c) => c.id === 'no-machine-id')

      expect(check?.status).toBe('pass')
    })
  })

  describe('matcher evaluation edge cases', () => {
    it('does not follow a symlink pointing outside the mount', () => {
      const outside = mkdtempSync(join(tmpdir(), 'attest-outside-'))
      try {
        writeFileSync(join(outside, 'secret.pem'), 'PRIVATE KEY')
        mkdirSync(join(mount, 'home'), { recursive: true })
        symlinkSync(outside, join(mount, 'home', 'link'))

        const check = runContamination(asFsView(mount), {
          policy: BUILTIN_POLICY
        }).checks.find((c) => c.id === 'no-pem-private-keys')

        // The .pem behind the symlink is never reached, so the rule passes.
        expect(check?.status).toBe('pass')
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('skips a content-regex rule whose target is unreadable (a directory)', () => {
      mkdirSync(join(mount, 'blob'), { recursive: true })
      const policy = {
        id: 'test/skip',
        rules: [
          {
            id: 'unreadable',
            title: 'unreadable target',
            matcher: {
              type: 'content-regex' as const,
              path: '/blob',
              pattern: 'x'
            }
          }
        ]
      }

      const check = runContamination(asFsView(mount), { policy }).checks[0]
      expect(check.status).toBe('skip')
      expect(check.detail).toMatch(/Could not evaluate rule "unreadable"/)
    })

    it('skips a content-regex rule with an invalid regex pattern', () => {
      write('etc/config', 'anything')
      const policy = {
        id: 'test/skip',
        rules: [
          {
            id: 'bad-regex',
            title: 'invalid regex',
            matcher: {
              type: 'content-regex' as const,
              path: '/etc/config',
              pattern: '([unterminated'
            }
          }
        ]
      }

      expect(
        runContamination(asFsView(mount), { policy }).checks[0].status
      ).toBe('skip')
    })

    it('fails a content-regex rule when contents match', () => {
      write('etc/secrets', 'api_key=ABCDEF')
      const policy = {
        id: 'test/content',
        rules: [
          {
            id: 'has-key',
            title: 'no api key',
            matcher: {
              type: 'content-regex' as const,
              path: '/etc/secrets',
              pattern: 'api_key='
            }
          }
        ]
      }
      expect(
        runContamination(asFsView(mount), { policy }).checks[0].status
      ).toBe('fail')
    })

    it('passes a content-regex rule when the present file does not match', () => {
      // A locked root account (root:*) must not trip the no-root-password rule.
      write('etc/shadow', 'root:*:19000:0:99999:7:::\n')

      const check = runContamination(asFsView(mount), {
        policy: BUILTIN_POLICY
      }).checks.find((c) => c.id === 'no-root-password')

      expect(check?.status).toBe('pass')
    })

    it('supports "?" and unbalanced-brace globs', () => {
      write('etc/hosts')
      write('etc/foo{bar')
      const policy = {
        id: 'test/glob',
        rules: [
          {
            id: 'question',
            title: 'single-char wildcard',
            matcher: { type: 'path-glob' as const, glob: '/etc/host?' }
          },
          {
            id: 'literal-brace',
            title: 'unbalanced brace treated literally',
            matcher: { type: 'path-glob' as const, glob: '/etc/foo{bar' }
          }
        ]
      }
      const checks = runContamination(asFsView(mount), { policy }).checks
      expect(checks.map((c) => c.status)).toEqual(['fail', 'fail'])
    })

    it('does not walk the filesystem when no path-glob rule is present', () => {
      write('var/lib/cloud/instance')
      const policy = {
        id: 'test/no-glob',
        rules: [
          {
            id: 'instance',
            title: 'cloud-init instance',
            matcher: {
              type: 'path-exists' as const,
              path: '/var/lib/cloud/instance'
            }
          }
        ]
      }
      expect(
        runContamination(asFsView(mount), { policy }).checks[0].status
      ).toBe('fail')
    })

    it('tolerates a missing mount when a path-glob rule is present', () => {
      const policy = {
        id: 'test/missing-mount',
        rules: [
          {
            id: 'glob',
            title: 'glob over missing mount',
            matcher: { type: 'path-glob' as const, glob: '/tmp/**' }
          }
        ]
      }
      const check = runContamination(asFsView(join(mount, 'nonexistent')), {
        policy
      }).checks[0]
      expect(check.status).toBe('pass')
    })
  })

  describe('loadPolicy', () => {
    const writePolicy = (obj: unknown): string => {
      const path = join(mount, 'policy.json')
      writeFileSync(path, JSON.stringify(obj))
      return path
    }

    it('returns the built-in policy with no digest when unset', async () => {
      const result = await loadPolicy()
      expect(result.policy).toBe(BUILTIN_POLICY)
      expect(result.sha256).toBeUndefined()
    })

    it('fully replaces the built-in set and records the file digest', async () => {
      const path = writePolicy({
        id: 'org/custom-v1',
        rules: [
          {
            id: 'only-rule',
            title: 'the only rule',
            matcher: { type: 'path-exists', path: '/nope' }
          }
        ]
      })

      const result = await loadPolicy(path)

      expect(result.policy.id).toBe('org/custom-v1')
      expect(result.policy.rules).toHaveLength(1)
      expect(result.sha256).toBe(await sha256File(path))

      // Replacement, not merge: runContamination sees only the custom rule and
      // records the custom digest.
      const { checks, policy } = runContamination(asFsView(mount), result)
      expect(checks).toHaveLength(1)
      expect(policy).toEqual({ id: 'org/custom-v1', sha256: result.sha256 })
    })

    it('validates all four matcher types in a custom policy', async () => {
      const path = writePolicy({
        id: 'org/all-types',
        rules: [
          {
            id: 'r1',
            title: 't1',
            matcher: { type: 'path-exists', path: '/a' }
          },
          {
            id: 'r2',
            title: 't2',
            matcher: { type: 'path-glob', glob: '/b/*' }
          },
          {
            id: 'r3',
            title: 't3',
            matcher: { type: 'content-regex', path: '/c', pattern: 'x' }
          },
          {
            id: 'r4',
            title: 't4',
            matcher: { type: 'non-empty-file', path: '/d' }
          }
        ]
      })

      const result = await loadPolicy(path)
      expect(result.policy.rules.map((r) => r.matcher.type)).toEqual([
        'path-exists',
        'path-glob',
        'content-regex',
        'non-empty-file'
      ])
    })

    it('preserves a path-glob exclude list from a custom policy', async () => {
      const path = writePolicy({
        id: 'org/with-exclude',
        rules: [
          {
            id: 'r1',
            title: 't1',
            matcher: {
              type: 'path-glob',
              glob: '/tmp/**',
              exclude: ['/tmp/.X11-unix']
            }
          }
        ]
      })

      const result = await loadPolicy(path)
      expect(result.policy.rules[0].matcher).toEqual({
        type: 'path-glob',
        glob: '/tmp/**',
        exclude: ['/tmp/.X11-unix']
      })
    })

    it('throws on non-JSON content', async () => {
      const path = join(mount, 'bad.json')
      writeFileSync(path, 'not json at all')
      await expect(loadPolicy(path)).rejects.toThrow(/is not valid JSON/)
    })

    it.each([
      ['a non-object policy', '"hello"', /must be a JSON object/],
      ['a null policy', 'null', /must be a JSON object/],
      ['a policy missing id', '{"rules":[]}', /missing a string "id"/],
      ['a policy missing rules', '{"id":"x"}', /missing a "rules" array/],
      ['a non-object rule', '{"id":"x","rules":[42]}', /is not an object/],
      [
        'a rule missing id',
        '{"id":"x","rules":[{"title":"t","matcher":{"type":"path-exists","path":"/a"}}]}',
        /is missing a string "id"/
      ],
      [
        'a rule missing title',
        '{"id":"x","rules":[{"id":"r","matcher":{"type":"path-exists","path":"/a"}}]}',
        /is missing a string "title"/
      ],
      [
        'a rule with no matcher object',
        '{"id":"x","rules":[{"id":"r","title":"t"}]}',
        /has no matcher object/
      ],
      [
        'an unknown matcher type',
        '{"id":"x","rules":[{"id":"r","title":"t","matcher":{"type":"path-nope"}}]}',
        /unknown matcher type "path-nope"/
      ],
      [
        'a matcher missing its field',
        '{"id":"x","rules":[{"id":"r","title":"t","matcher":{"type":"path-glob"}}]}',
        /missing the string field "glob"/
      ],
      [
        'a path-glob exclude that is not a string array',
        '{"id":"x","rules":[{"id":"r","title":"t","matcher":{"type":"path-glob","glob":"/tmp/**","exclude":[1]}}]}',
        /"exclude" that must be an array of strings/
      ]
    ] as const)('throws on %s', async (_name, body, pattern) => {
      const path = join(mount, 'malformed.json')
      writeFileSync(path, body)
      await expect(loadPolicy(path)).rejects.toThrow(pattern)
    })
  })
})
