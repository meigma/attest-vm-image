import * as fs from 'node:fs'
import * as path from 'node:path'
import { sha256File } from './hash.js'
import type { FsView } from './inspect.js'

/**
 * A contamination matcher. All four shapes are evaluated read-only against
 * `fsView.mountPath`; a rule fails when its matcher hits, passes when it does
 * not, and is skipped when it cannot be evaluated.
 */
export type Matcher =
  | { type: 'path-exists'; path: string }
  | { type: 'path-glob'; glob: string; exclude?: string[] }
  | { type: 'content-regex'; path: string; pattern: string }
  | { type: 'non-empty-file'; path: string }

/** A single contamination rule: a stable id, a human title, and a matcher. */
export interface PolicyRule {
  id: string
  title: string
  matcher: Matcher
}

/** A contamination policy: an id and its ordered rule set. */
export interface Policy {
  id: string
  rules: PolicyRule[]
}

/** The result of resolving a policy: the policy plus its file digest, if loaded from disk. */
export interface PolicyResult {
  policy: Policy
  sha256?: string
}

/** Outcome of one evaluated rule. */
export type CheckStatus = 'pass' | 'fail' | 'skip'

/** A single evaluated contamination check. */
export interface Check {
  id: string
  title: string
  status: CheckStatus
  detail: string
}

/** The policy identity recorded in the predicate alongside the checks. */
export interface PolicyIdentity {
  id: string
  sha256?: string
}

/** The full contamination result: per-rule checks plus the policy identity. */
export interface ContaminationResult {
  checks: Check[]
  policy: PolicyIdentity
}

/**
 * The built-in contamination policy. Covers state that must not ship baked into
 * a reusable image: runner registration credentials, private keys and obvious
 * credential files, persisted SSH host keys, non-empty machine identity,
 * cloud-init instance state, package-manager/provisioning credentials, and
 * build temp files. Globs are scoped to home/system locations to avoid false
 * positives (for example, `*.pem` is limited to home directories, not
 * `/etc/ssl`). A `policy-path` input fully replaces this set.
 */
export const BUILTIN_POLICY: Policy = {
  id: 'builtin/v1',
  rules: [
    {
      id: 'no-runner-credentials',
      title: 'GitHub Actions runner registration credentials are absent',
      matcher: { type: 'path-glob', glob: '**/actions-runner/.credentials*' }
    },
    {
      id: 'no-runner-registration',
      title: 'GitHub Actions runner registration state is absent',
      matcher: { type: 'path-glob', glob: '**/actions-runner/.runner' }
    },
    {
      id: 'no-ssh-private-keys',
      title: 'SSH private keys are absent from home directories',
      matcher: {
        type: 'path-glob',
        glob: '/{root,home}/**/.ssh/id_{rsa,dsa,ecdsa,ed25519}'
      }
    },
    {
      id: 'no-pem-private-keys',
      title: 'PEM private-key files are absent from home directories',
      matcher: { type: 'path-glob', glob: '/{root,home}/**/*.pem' }
    },
    {
      id: 'no-ssh-host-keys',
      title: 'Persisted SSH host keys are absent',
      matcher: { type: 'path-glob', glob: '/etc/ssh/ssh_host_*_key*' }
    },
    {
      id: 'no-machine-id',
      title: 'Machine identity is cleared for regeneration',
      matcher: { type: 'non-empty-file', path: '/etc/machine-id' }
    },
    {
      id: 'no-dbus-machine-id',
      title: 'D-Bus machine identity is cleared for regeneration',
      // The dbus package's postinst always creates this path as a symlink to
      // /etc/machine-id, so its mere presence is not contamination. `non-empty-file`
      // follows the symlink and tests the resolved target's content, matching the
      // sibling no-machine-id check.
      matcher: { type: 'non-empty-file', path: '/var/lib/dbus/machine-id' }
    },
    {
      id: 'no-cloud-init-instance',
      title: 'Cloud-init instance state is absent',
      matcher: { type: 'path-exists', path: '/var/lib/cloud/instance' }
    },
    {
      id: 'no-cloud-init-instances',
      title: 'Cloud-init per-instance data directory is absent',
      matcher: { type: 'path-exists', path: '/var/lib/cloud/instances' }
    },
    {
      id: 'no-apt-auth-conf',
      title: 'APT authentication credentials are absent',
      matcher: { type: 'path-exists', path: '/etc/apt/auth.conf' }
    },
    {
      id: 'no-apt-auth-conf-d',
      title: 'APT auth.conf.d credential fragments are absent',
      matcher: { type: 'path-glob', glob: '/etc/apt/auth.conf.d/*' }
    },
    {
      id: 'no-netrc-credentials',
      title: 'netrc credential files are absent from home directories',
      matcher: { type: 'path-glob', glob: '/{root,home}/**/.netrc' }
    },
    {
      id: 'no-build-temp-files',
      title: 'Build temporary files are absent from /tmp',
      // A once-booted image carries systemd's standard /tmp skeleton
      // (`.X11-unix` and friends) and PrivateTmp sandboxes, none of which are
      // build contamination; they are excluded so the rule flags only genuine
      // leftovers. Each exclusion also covers that entry's subtree.
      matcher: {
        type: 'path-glob',
        glob: '/tmp/**',
        exclude: [
          '/tmp/.X11-unix',
          '/tmp/.ICE-unix',
          '/tmp/.font-unix',
          '/tmp/.XIM-unix',
          '/tmp/.Test-unix',
          '/tmp/systemd-private-*'
        ]
      }
    },
    {
      id: 'no-root-shell-history',
      title: "root's shell history is absent",
      matcher: { type: 'path-exists', path: '/root/.bash_history' }
    },
    {
      id: 'no-root-password',
      title: 'root has no set password in /etc/shadow',
      matcher: {
        type: 'content-regex',
        path: '/etc/shadow',
        pattern: '^root:[^*!:]'
      }
    }
  ]
}

// Convert one glob token stream into a regular-expression source fragment,
// anchored by the caller. Supports `**` (any depth), `*` (within a segment),
// `?` (one non-separator character), and `{a,b}` brace alternation. Every other
// character is matched literally.
function globToRegExpSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) {
        out += '\\{'
      } else {
        const alternatives = glob.slice(i + 1, end).split(',')
        out += '(?:' + alternatives.map(globToRegExpSource).join('|') + ')'
        i = end
      }
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

// Compile a glob (absolute globs are anchored at the mount root) to an anchored
// RegExp matched against mount-relative POSIX paths.
function globToRegExp(glob: string): RegExp {
  const relative = glob.startsWith('/') ? glob.slice(1) : glob
  return new RegExp('^' + globToRegExpSource(relative) + '$')
}

// Recursively list every entry under `root` as a mount-relative POSIX path,
// WITHOUT following symlinks: a symlinked directory is recorded but never
// descended, so a link pointing outside the mount cannot escape the walk.
// Unreadable directories are skipped rather than aborting the whole walk.
function walkEntries(root: string): string[] {
  const results: string[] = []
  const recurse = (relativeDir: string): void => {
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(path.join(root, relativeDir), {
        withFileTypes: true
      })
    } catch {
      return
    }
    for (const dirent of dirents) {
      const relative = relativeDir
        ? `${relativeDir}/${dirent.name}`
        : dirent.name
      results.push(relative)
      if (dirent.isDirectory()) recurse(relative)
    }
  }
  recurse('')
  return results
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

// Evaluate one matcher, returning a pass/fail outcome. A thrown error (an
// unreadable file for content-regex, an invalid regex) propagates to the caller,
// which records the rule as skipped.
function matcherCheck(
  matcher: Matcher,
  mountPath: string,
  entries: string[]
): { status: 'pass' | 'fail'; detail: string } {
  switch (matcher.type) {
    case 'path-exists': {
      const target = path.join(mountPath, matcher.path)
      let exists: boolean
      try {
        fs.lstatSync(target)
        exists = true
      } catch {
        exists = false
      }
      return exists
        ? { status: 'fail', detail: `Path exists: ${matcher.path}` }
        : { status: 'pass', detail: `Path is absent: ${matcher.path}` }
    }
    case 'path-glob': {
      const re = globToRegExp(matcher.glob)
      const excludes = (matcher.exclude ?? []).map(globToRegExp)
      // An entry is excluded when it, or any of its ancestor paths, matches an
      // exclusion glob — so excluding a directory also excludes its subtree.
      const isExcluded = (entry: string): boolean => {
        const segments = entry.split('/')
        for (let i = segments.length; i > 0; i--) {
          const prefix = segments.slice(0, i).join('/')
          if (excludes.some((ex) => ex.test(prefix))) return true
        }
        return false
      }
      const hit = entries.find((entry) => re.test(entry) && !isExcluded(entry))
      return hit
        ? { status: 'fail', detail: `Glob ${matcher.glob} matched: ${hit}` }
        : { status: 'pass', detail: `No path matched glob: ${matcher.glob}` }
    }
    case 'content-regex': {
      const target = path.join(mountPath, matcher.path)
      let content: string
      try {
        content = fs.readFileSync(target, 'utf8')
      } catch (err) {
        if (isENOENT(err)) {
          return { status: 'pass', detail: `File is absent: ${matcher.path}` }
        }
        throw err
      }
      const re = new RegExp(matcher.pattern)
      return re.test(content)
        ? {
            status: 'fail',
            detail: `Content of ${matcher.path} matched pattern`
          }
        : {
            status: 'pass',
            detail: `Content of ${matcher.path} did not match pattern`
          }
    }
    case 'non-empty-file': {
      const target = path.join(mountPath, matcher.path)
      let size: number
      try {
        size = fs.statSync(target).size
      } catch {
        return { status: 'pass', detail: `File is absent: ${matcher.path}` }
      }
      return size > 0
        ? {
            status: 'fail',
            detail: `File is present and non-empty: ${matcher.path}`
          }
        : {
            status: 'pass',
            detail: `File is present but empty: ${matcher.path}`
          }
    }
  }
}

/**
 * Evaluate a resolved policy read-only against `fsView.mountPath`, returning a
 * per-rule check list and the policy identity for the predicate. A rule whose
 * matcher cannot be evaluated is reported as `skip` (never a throw), so one
 * unreadable file cannot strand the rest of the checks.
 */
export function runContamination(
  fsView: FsView,
  policyResult: PolicyResult
): ContaminationResult {
  const { policy } = policyResult
  const needsWalk = policy.rules.some(
    (rule) => rule.matcher.type === 'path-glob'
  )
  const entries = needsWalk ? walkEntries(fsView.mountPath) : []

  const checks: Check[] = policy.rules.map((rule) => {
    try {
      const { status, detail } = matcherCheck(
        rule.matcher,
        fsView.mountPath,
        entries
      )
      return { id: rule.id, title: rule.title, status, detail }
    } catch (err) {
      return {
        id: rule.id,
        title: rule.title,
        status: 'skip',
        detail: `Could not evaluate rule "${rule.id}": ${String(err)}`
      }
    }
  })

  const identity: PolicyIdentity =
    policyResult.sha256 !== undefined
      ? { id: policy.id, sha256: policyResult.sha256 }
      : { id: policy.id }

  return { checks, policy: identity }
}

function requireString(
  value: unknown,
  ruleId: string,
  policyPath: string,
  field: string
): void {
  if (typeof value !== 'string') {
    throw new Error(
      `Rule "${ruleId}" in policy "${policyPath}" has a matcher missing the ` +
        `string field "${field}".`
    )
  }
}

// Validate an optional array-of-strings matcher field. Absent (undefined) is
// allowed; anything else must be a string[] or the policy fails closed.
function requireOptionalStringArray(
  value: unknown,
  ruleId: string,
  policyPath: string,
  field: string
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(
      `Rule "${ruleId}" in policy "${policyPath}" has a matcher field ` +
        `"${field}" that must be an array of strings.`
    )
  }
  return value as string[]
}

function validateMatcher(
  value: unknown,
  ruleId: string,
  policyPath: string
): Matcher {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `Rule "${ruleId}" in policy "${policyPath}" has no matcher object.`
    )
  }
  const obj = value as Record<string, unknown>
  switch (obj.type) {
    case 'path-exists':
      requireString(obj.path, ruleId, policyPath, 'path')
      return { type: 'path-exists', path: obj.path as string }
    case 'path-glob': {
      requireString(obj.glob, ruleId, policyPath, 'glob')
      const exclude = requireOptionalStringArray(
        obj.exclude,
        ruleId,
        policyPath,
        'exclude'
      )
      return exclude === undefined
        ? { type: 'path-glob', glob: obj.glob as string }
        : { type: 'path-glob', glob: obj.glob as string, exclude }
    }
    case 'content-regex':
      requireString(obj.path, ruleId, policyPath, 'path')
      requireString(obj.pattern, ruleId, policyPath, 'pattern')
      return {
        type: 'content-regex',
        path: obj.path as string,
        pattern: obj.pattern as string
      }
    case 'non-empty-file':
      requireString(obj.path, ruleId, policyPath, 'path')
      return { type: 'non-empty-file', path: obj.path as string }
    default:
      throw new Error(
        `Rule "${ruleId}" in policy "${policyPath}" has an unknown matcher ` +
          `type "${String(obj.type)}".`
      )
  }
}

function validateRule(
  value: unknown,
  index: number,
  policyPath: string
): PolicyRule {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `Rule at index ${index} in policy "${policyPath}" is not an object.`
    )
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.id !== 'string') {
    throw new Error(
      `Rule at index ${index} in policy "${policyPath}" is missing a string "id".`
    )
  }
  if (typeof obj.title !== 'string') {
    throw new Error(
      `Rule "${obj.id}" in policy "${policyPath}" is missing a string "title".`
    )
  }
  const matcher = validateMatcher(obj.matcher, obj.id, policyPath)
  return { id: obj.id, title: obj.title, matcher }
}

function validatePolicy(value: unknown, policyPath: string): Policy {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `Contamination policy "${policyPath}" must be a JSON object.`
    )
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.id !== 'string') {
    throw new Error(
      `Contamination policy "${policyPath}" is missing a string "id".`
    )
  }
  if (!Array.isArray(obj.rules)) {
    throw new Error(
      `Contamination policy "${policyPath}" is missing a "rules" array.`
    )
  }
  const rules = obj.rules.map((rule, index) =>
    validateRule(rule, index, policyPath)
  )
  return { id: obj.id, rules }
}

/**
 * Resolve the contamination policy. With no `policyPath`, returns the built-in
 * policy. With a path, parses and fully validates the JSON policy file (a
 * malformed file or unknown matcher type throws, naming the offending rule),
 * **fully replaces** the built-in set, and records the file's SHA-256.
 */
export async function loadPolicy(policyPath?: string): Promise<PolicyResult> {
  if (policyPath === undefined) {
    return { policy: BUILTIN_POLICY }
  }
  const raw = fs.readFileSync(policyPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Contamination policy "${policyPath}" is not valid JSON.`)
  }
  const policy = validatePolicy(parsed, policyPath)
  return { policy, sha256: await sha256File(policyPath) }
}
