import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import { sha256File } from './hash.js'
import { exec } from './exec.js'

// package.json is loaded through createRequire rather than a static JSON import.
// Under tsconfig's `module: NodeNext`, a JSON import must carry a
// `with { type: 'json' }` attribute; that attribute is then emitted verbatim by
// @rollup/plugin-typescript, which cannot resolve it and degrades to returning
// untransformed TypeScript for the whole program — breaking the rollup bundle.
// createRequire keeps JSON resolution entirely off the TS compiler's path. The
// action's repository (including package.json, one level up from dist/index.js)
// is checked out at runtime, so `../package.json` resolves for both the bundled
// action and the test/src layout.
const packageJson = createRequire(import.meta.url)('../package.json') as {
  name: string
  version: string
}

/** Supported runner platform keys (`process.platform`-`process.arch`). */
export type PlatformKey = 'linux-x64' | 'linux-arm64'

/**
 * A pinned standalone tool: an exact version, a release-URL template, and a
 * per-platform SHA-256 digest the download is verified against.
 */
export interface ToolPin {
  version: string
  urlTemplate: string
  sha256: Record<PlatformKey, string>
}

/**
 * Pinned standalone binaries downloaded from GitHub Releases and integrity-
 * verified against these digests. These literals are the sole source of truth,
 * read only by this module. Pins are bumped by a reviewed PR (labeled like any
 * other dependency change) — never edited casually — because they are the trust
 * anchor for the downloaded tools.
 */
export const PINNED_TOOLS: Record<'syft' | 'grype', ToolPin> = {
  syft: {
    version: '1.48.0',
    urlTemplate:
      'https://github.com/anchore/syft/releases/download/v{version}/syft_{version}_linux_{arch}.tar.gz',
    sha256: {
      'linux-x64':
        '6cef9a7f37220d9067eaf9cfaaa2fce986e9f320a8d42cbc36658c99af78ea04',
      'linux-arm64':
        '6865a3d97c4e28b4b38571c17a2bf512da4494ef1d37613c3122fce0d67e63b0'
    }
  },
  grype: {
    version: '0.116.0',
    urlTemplate:
      'https://github.com/anchore/grype/releases/download/v{version}/grype_{version}_linux_{arch}.tar.gz',
    sha256: {
      'linux-x64':
        '40aff724297312f91ea390d003bed8d8651c74cc7f5b26732db80b3a408d2fc5',
      'linux-arm64':
        '7af3eed24f469b0cf3ab5ec4508d9c12f4bb9c2c6be714f32973c7b5d63cb6a5'
    }
  }
}

/**
 * apt packages installed from Ubuntu's signed archive. No version pin: the
 * Ubuntu archive carries only the current build, so the action installs
 * whatever the runner image provides and records the actually-installed version
 * (via `dpkg-query`) after the fact.
 */
export const APT_PACKAGES = ['qemu-utils', 'libguestfs-tools'] as const

// Maps a platform key to the architecture token Anchore uses in release asset
// names (`amd64`/`arm64`), substituted into `urlTemplate`.
const URL_ARCH: Record<PlatformKey, string> = {
  'linux-x64': 'amd64',
  'linux-arm64': 'arm64'
}

/**
 * Resolve the runner's platform key, throwing a clear diagnostic on an
 * unsupported platform or architecture.
 */
export function platformKey(): PlatformKey {
  const { platform, arch } = process
  if (platform !== 'linux') {
    throw new Error(
      `attest-vm-image runs only on Linux runners; detected platform "${platform}". ` +
        'Use an ubuntu-* runner.'
    )
  }
  if (arch === 'x64') return 'linux-x64'
  if (arch === 'arm64') return 'linux-arm64'
  throw new Error(
    `attest-vm-image supports only x64 and arm64 Linux runners; detected architecture "${arch}".`
  )
}

/**
 * Ensure a pinned standalone binary (`syft`/`grype`) is available, returning the
 * directory containing it. Checks the tool cache first; otherwise downloads the
 * templated release asset, recomputes its SHA-256, and compares to the pin —
 * aborting (never extracting, never caching) on any mismatch. A verified
 * download is extracted and cached for reuse.
 */
export async function ensureBinary(name: 'syft' | 'grype'): Promise<string> {
  const pin = PINNED_TOOLS[name]
  const key = platformKey()

  const cached = tc.find(name, pin.version, key)
  if (cached) {
    core.info(`Using cached ${name} ${pin.version} from ${cached}.`)
    return cached
  }

  const url = pin.urlTemplate
    .replaceAll('{version}', pin.version)
    .replaceAll('{arch}', URL_ARCH[key])

  core.info(`Downloading ${name} ${pin.version} (${key}) from ${url}.`)
  const downloaded = await tc.downloadTool(url)

  const actual = await sha256File(downloaded)
  const expected = pin.sha256[key]
  if (actual !== expected) {
    throw new Error(
      `Integrity check failed for ${name} ${pin.version} (${key}): ` +
        `expected sha256 ${expected}, got ${actual}. ` +
        'Refusing to extract or cache the download.'
    )
  }

  const extracted = await tc.extractTar(downloaded)
  return tc.cacheDir(extracted, name, pin.version, key)
}

/**
 * Install the required apt packages from Ubuntu's signed archive, then apply the
 * libguestfs kernel-readability fixup. The libguestfs direct backend builds its
 * supermin appliance from the host kernel image, which Ubuntu ships root-
 * readable only; the non-root runner user must be able to read it or the first
 * `guestmount` fails. Fails closed if the install fails or no readable
 * `/boot/vmlinuz-*` remains afterwards.
 */
export async function ensureAptPackages(): Promise<void> {
  await exec('sudo', ['apt-get', 'update'])
  await exec('sudo', [
    'apt-get',
    'install',
    '-y',
    '--no-install-recommends',
    ...APT_PACKAGES
  ])

  await exec('sudo', ['sh', '-c', 'chmod +r /boot/vmlinuz-*'])

  let kernels: string[]
  try {
    kernels = fs
      .readdirSync('/boot')
      .filter((entry) => entry.startsWith('vmlinuz-'))
      .map((entry) => path.join('/boot', entry))
  } catch {
    kernels = []
  }

  const readable = kernels.some((kernel) => {
    try {
      fs.accessSync(kernel, fs.constants.R_OK)
      return true
    } catch {
      return false
    }
  })

  if (!readable) {
    throw new Error(
      'No readable kernel image at /boot/vmlinuz-* after chmod. The libguestfs ' +
        'direct backend supermin appliance must read the host kernel image as ' +
        'the non-root runner user; without it guestmount fails.'
    )
  }
}

/** A resolved tool name and version for the predicate's `tools` array. */
export interface ToolVersion {
  name: string
  version: string
}

/**
 * Resolve name/version pairs for the predicate: `syft`/`grype` from the pins,
 * the apt packages from `dpkg-query` (their actually-installed versions — call
 * only AFTER {@link ensureAptPackages}), and this action's own name/version.
 */
export async function toolVersions(): Promise<ToolVersion[]> {
  const versions: ToolVersion[] = [
    { name: 'syft', version: PINNED_TOOLS.syft.version },
    { name: 'grype', version: PINNED_TOOLS.grype.version }
  ]

  const { stdout } = await exec('dpkg-query', [
    '-W',
    '-f',
    '${Package} ${Version}\n',
    ...APT_PACKAGES
  ])
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // A non-empty trimmed line always yields a package token; the version is
    // absent only for malformed output, defaulted to '' so parsing never throws.
    const [pkg, version] = trimmed.split(/\s+/)
    versions.push({ name: pkg, version: version ?? '' })
  }

  versions.push({ name: packageJson.name, version: packageJson.version })
  return versions
}
