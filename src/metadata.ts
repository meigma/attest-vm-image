import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { sha256File } from './hash.js'
import { exec } from './exec.js'
import type { CleanupRegistry } from './cleanup.js'

/** Validated Incus metadata: the archive digest plus its raw properties. */
export interface MetadataInfo {
  /** SHA-256 of the metadata tarball (lowercase hex). */
  sha256: string
  /** The raw `properties` object from `metadata.yaml` (empty when absent). */
  properties: Record<string, unknown>
}

// A single parsed `tar -tvf` entry. `linkTarget` is set for symlinks and
// hardlinks only.
interface TarEntry {
  type: string
  name: string
  linkTarget?: string
}

// A virtual extraction root used only for normalized path-escape checks. The
// real extraction happens into a fresh temp directory later.
const VIRTUAL_ROOT = '/__attest_extract__'

// Parse one `tar -tvf` (GNU tar verbose) line. The leading permission string's
// first character is the entry type (`-` file, `d` dir, `l` symlink, `h`
// hardlink, `c`/`b` device, `p` fifo). Returns null for blank lines. Device
// lines are classified and rejected by type, not by name; GNU tar prints the
// device `major,minor` field with no internal space (e.g. `1,3` or `253,100`),
// so it occupies a single size column and the fixed-column split below stays
// aligned regardless.
function parseTarLine(line: string): TarEntry | null {
  const trimmed = line.trimEnd()
  if (!trimmed.trim()) return null
  const type = trimmed[0]

  // For entries we might keep (file/dir/symlink/hardlink), the size column is a
  // plain integer, so a fixed-column split is safe. A line that does not match
  // the expected column layout is treated as an unparseable listing and fails
  // closed rather than being silently admitted.
  const match = /^.{10}\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(trimmed)
  if (!match) {
    throw new Error(`Unparseable tar listing line: "${trimmed}".`)
  }
  const rest = match[1]

  if (type === 'l') {
    const [name, ...targetParts] = rest.split(' -> ')
    return {
      type,
      name: name.trim(),
      linkTarget: targetParts.join(' -> ').trim()
    }
  }
  if (type === 'h') {
    const [name, ...targetParts] = rest.split(' link to ')
    return {
      type,
      name: name.trim(),
      linkTarget: targetParts.join(' link to ').trim()
    }
  }
  return { type, name: rest.trim() }
}

// Return true when `target`, resolved from `fromDir`, stays within VIRTUAL_ROOT.
// Uses normalized joined paths (path.resolve), never string prefixes.
function withinRoot(fromDir: string, target: string): boolean {
  const resolved = path.resolve(fromDir, target)
  return (
    resolved === VIRTUAL_ROOT || resolved.startsWith(VIRTUAL_ROOT + path.sep)
  )
}

// Normalize an entry name for path-component comparison: strip any trailing
// slash (directories list with one) so `templates/` and `templates` compare
// equal.
function normalizeName(name: string): string {
  return name.replace(/\/+$/, '')
}

// The entry types this stage understands and may keep: file, directory,
// symlink, hardlink. Everything else fails closed.
const KNOWN_TYPES = new Set(['-', 'd', 'l', 'h'])

// Reject an unsafe archive entry, throwing a distinct diagnostic per class.
// `symlinkPaths` is the set of every symlink entry name in the archive
// (normalized); it lets us reject any entry whose parent path traverses a
// declared symlink, closing the symlink-chain escape where a lexically-safe
// entry lands outside the root because one of its parent components is itself a
// symlink pointing elsewhere.
function assertSafeEntry(entry: TarEntry, symlinkPaths: Set<string>): void {
  const { type, name, linkTarget } = entry

  if (type === 'c' || type === 'b') {
    throw new Error(
      `Unsafe archive entry "${name}": device nodes are not allowed.`
    )
  }
  if (type === 'p') {
    throw new Error(`Unsafe archive entry "${name}": FIFOs are not allowed.`)
  }
  // Fail closed on any type we do not explicitly handle. Real GNU tar cannot
  // emit a socket typeflag; an unrecognized typeflag lists with a leading `?`
  // ("unknown file type 'X'"), which lands here rather than being silently
  // admitted as a regular file.
  if (!KNOWN_TYPES.has(type)) {
    throw new Error(
      `Unsafe archive entry "${name}": unsupported file type "${type}".`
    )
  }

  if (name.startsWith('/')) {
    throw new Error(
      `Unsafe archive entry "${name}": absolute paths are not allowed.`
    )
  }
  if (name.split('/').some((segment) => segment === '..')) {
    throw new Error(
      `Unsafe archive entry "${name}": parent-directory ("..") traversal is not allowed.`
    )
  }

  // Reject any entry whose parent path traverses a declared symlink. A symlink
  // component could redirect this entry's physical location outside the root at
  // extraction time even when the entry's own name and (lexical) target look
  // safe.
  const parts = normalizeName(name).split('/')
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    if (symlinkPaths.has(prefix)) {
      throw new Error(
        `Unsafe archive entry "${name}": a parent path component "${prefix}" is a symlink, which could redirect extraction outside the root.`
      )
    }
  }

  if (type === 'l' && linkTarget !== undefined) {
    const linkDir = path.dirname(path.join(VIRTUAL_ROOT, name))
    if (!withinRoot(linkDir, linkTarget)) {
      throw new Error(
        `Unsafe archive entry "${name}": symlink target "${linkTarget}" escapes the extraction root.`
      )
    }
  }
  if (type === 'h' && linkTarget !== undefined) {
    if (!withinRoot(VIRTUAL_ROOT, linkTarget)) {
      throw new Error(
        `Unsafe archive entry "${name}": hardlink target "${linkTarget}" escapes the extraction root.`
      )
    }
  }
}

/**
 * Validate an Incus metadata tarball read-only, extract it into a fresh temp
 * directory, and return its digest and raw properties. Every entry is inspected
 * **before** extraction: absolute paths, `..` traversal, symlink/hardlink
 * escapes (including symlink-chain escapes via a symlinked parent), device and
 * fifo nodes, and any unrecognized entry type are rejected with distinct
 * diagnostics.
 * A `metadata.yaml` at the archive root is required, and `architecture` /
 * `creation_date` must be present. Extraction targets a fresh temp directory
 * registered for cleanup. Fails closed on any violation.
 */
export async function validateMetadata(
  archivePath: string,
  registry: CleanupRegistry
): Promise<MetadataInfo> {
  // 1. List entries before extraction (GNU tar auto-detects compression).
  const listing = await exec('tar', ['-tvf', archivePath])
  const entries: TarEntry[] = []
  for (const line of listing.stdout.split('\n')) {
    const entry = parseTarLine(line)
    if (entry) entries.push(entry)
  }

  // Collect every declared symlink up front so the per-entry check can reject a
  // path whose parent traverses a symlink regardless of archive ordering.
  const symlinkPaths = new Set(
    entries
      .filter((entry) => entry.type === 'l')
      .map((entry) => normalizeName(entry.name))
  )
  for (const entry of entries) {
    assertSafeEntry(entry, symlinkPaths)
  }

  // 2. Require metadata.yaml at the archive root.
  const hasMetadata = entries.some(
    (entry) => entry.type === '-' && entry.name === 'metadata.yaml'
  )
  if (!hasMetadata) {
    throw new Error(
      `Archive "${archivePath}" does not contain a metadata.yaml at its root.`
    )
  }

  // 3. Extract into a fresh temp directory registered for cleanup.
  const extractDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'attest-metadata-')
  )
  registry.add(async () => {
    await fs.promises.rm(extractDir, { recursive: true, force: true })
  })
  await exec('tar', ['-xf', archivePath, '-C', extractDir, '--no-same-owner'])

  // 4. Parse metadata.yaml and validate required Incus fields.
  const body = await fs.promises.readFile(
    path.join(extractDir, 'metadata.yaml'),
    'utf8'
  )
  const parsed = (yaml.load(body) ?? {}) as Record<string, unknown>

  for (const field of ['architecture', 'creation_date']) {
    if (parsed[field] === undefined) {
      throw new Error(
        `metadata.yaml in "${archivePath}" is missing the required field "${field}".`
      )
    }
  }

  const properties =
    parsed.properties && typeof parsed.properties === 'object'
      ? (parsed.properties as Record<string, unknown>)
      : {}

  return {
    sha256: await sha256File(archivePath),
    properties
  }
}
