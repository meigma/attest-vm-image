import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { exec } from './exec.js'
import type { CleanupRegistry } from './cleanup.js'

/** Operating-system identity read from the guest's `/etc/os-release`. */
export interface OperatingSystem {
  /** `ID` field, e.g. `ubuntu`. */
  id: string
  /** `VERSION_ID` field, e.g. `24.04`. */
  versionId: string
  /** `PRETTY_NAME` field, e.g. `Ubuntu 24.04.1 LTS`. */
  prettyName: string
  /** libguestfs-detected architecture, e.g. `x86_64`. */
  arch: string
}

/** A single installed OS package. */
export interface Package {
  name: string
  version: string
}

/**
 * The single read-only view of the inspected guest filesystem that later stages
 * (SBOM, contamination) both read. Exactly one FUSE mount backs `mountPath` for
 * the whole run.
 */
export interface FsView {
  operatingSystem: OperatingSystem
  packages: Package[]
  mountPath: string
}

// Every libguestfs invocation runs the appliance under the direct backend so the
// untrusted filesystem is parsed by the isolated appliance kernel, never the
// host kernel.
function libguestfsEnv(): Record<string, string> {
  return { ...process.env, LIBGUESTFS_BACKEND: 'direct' } as Record<
    string,
    string
  >
}

// Parse `guestfish inspect-os` output: one root device per line.
function parseRoots(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// Parse an `/etc/os-release` file body into an OS identity (arch supplied
// separately). Values may be quoted; only the fields we need are extracted.
function parseOsRelease(body: string, arch: string): OperatingSystem {
  const fields: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return {
    id: fields.ID ?? '',
    versionId: fields.VERSION_ID ?? '',
    prettyName: fields.PRETTY_NAME ?? '',
    arch
  }
}

// Parse `guestfish inspect-list-applications2` output. guestfish prints a list
// of structs as `[N] = { app2_name: ...\n app2_version: ... }` blocks; the
// leading `inspect-os` root line and non-`app2_*` fields are ignored.
function parseApplications(stdout: string): Package[] {
  const packages: Package[] = []
  let name: string | undefined
  let version: string | undefined
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    const nameMatch = /^app2_name:\s*(.*)$/.exec(line)
    if (nameMatch) {
      name = nameMatch[1].trim()
      continue
    }
    const versionMatch = /^app2_version:\s*(.*)$/.exec(line)
    if (versionMatch) {
      version = versionMatch[1].trim()
      continue
    }
    if (line === '}') {
      if (name) packages.push({ name, version: version ?? '' })
      name = undefined
      version = undefined
    }
  }
  return packages
}

/**
 * Inspect a QCOW2 disk read-only inside the isolated libguestfs appliance and
 * return the single `fsView` later stages read. Detects the OS root (exactly one
 * is required), the architecture, mounts the root read-only over FUSE into a
 * fresh temp directory, reads `/etc/os-release`, and inventories installed
 * packages. Registers a single teardown (unmount + temp-dir removal) on the
 * cleanup registry. Fails closed when no OS is detected, `/etc/os-release` is
 * absent, or the package database is empty.
 */
export async function inspectFilesystem(
  diskPath: string,
  registry: CleanupRegistry
): Promise<FsView> {
  const env = libguestfsEnv()

  // 1. Detect the OS root(s); exactly one is supported.
  const osResult = await exec(
    'guestfish',
    ['--ro', '-a', diskPath, 'run', ':', 'inspect-os'],
    { env }
  )
  const roots = parseRoots(osResult.stdout)
  if (roots.length === 0) {
    throw new Error(
      `No operating system detected in "${diskPath}"; libguestfs found no root filesystem.`
    )
  }
  if (roots.length > 1) {
    throw new Error(
      `Multiple operating systems detected in "${diskPath}" (${roots.join(
        ', '
      )}); multi-boot images are not supported.`
    )
  }
  const root = roots[0]

  // 2. Resolve the architecture (inspect-os must run first in the session to
  // populate inspection data, so it is chained ahead of inspect-get-arch).
  const archResult = await exec(
    'guestfish',
    [
      '--ro',
      '-a',
      diskPath,
      'run',
      ':',
      'inspect-os',
      ':',
      'inspect-get-arch',
      root
    ],
    { env }
  )
  const archLines = parseRoots(archResult.stdout)
  const arch = archLines[archLines.length - 1] ?? ''

  // 3. Mount the root read-only over FUSE into a fresh temp directory.
  const mountPath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'attest-mount-')
  )

  // Register cleanup BEFORE guestmount so a guestmount failure still removes the
  // freshly-created temp directory. guestunmount uses ignoreReturnCode, so an
  // unmount attempt on a path that was never mounted is harmless; it is retried
  // once on failure.
  registry.add(async () => {
    const first = await exec('guestunmount', [mountPath], {
      env,
      ignoreReturnCode: true
    })
    if (first.exitCode !== 0) {
      await exec('guestunmount', [mountPath], { env, ignoreReturnCode: true })
    }
    await fs.promises.rm(mountPath, { recursive: true, force: true })
  })

  await exec('guestmount', ['--ro', '-a', diskPath, '-i', mountPath], { env })

  // 4. Read and parse /etc/os-release from the mounted filesystem.
  let osReleaseBody: string
  try {
    osReleaseBody = await fs.promises.readFile(
      path.join(mountPath, 'etc', 'os-release'),
      'utf8'
    )
  } catch {
    throw new Error(
      `Could not read /etc/os-release from "${diskPath}"; the guest filesystem could not be fully inspected.`
    )
  }
  const operatingSystem = parseOsRelease(osReleaseBody, arch)

  // 5. Inventory installed packages. inspect-list-applications2 reads files from
  // the guest root, so the root filesystem must be mounted in the same guestfish
  // session first; without the mount step guestfish fails with "you must call
  // 'mount' first to mount the root filesystem". An empty inventory is a
  // fail-closed error.
  const appsResult = await exec(
    'guestfish',
    [
      '--ro',
      '-a',
      diskPath,
      'run',
      ':',
      'inspect-os',
      ':',
      'mount',
      root,
      '/',
      ':',
      'inspect-list-applications2',
      root
    ],
    { env }
  )
  const packages = parseApplications(appsResult.stdout)
  if (packages.length === 0) {
    throw new Error(
      `The package database cannot be enumerated for "${diskPath}"; refusing to emit an empty package inventory.`
    )
  }

  return { operatingSystem, packages, mountPath }
}
