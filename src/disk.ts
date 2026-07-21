import * as fs from 'node:fs'
import { sha256File } from './hash.js'
import { exec } from './exec.js'

/**
 * Structural facts about a validated QCOW2 disk image, gathered read-only.
 * `sha256` is stored as `state.disk.sha256` and re-verified by the checksum
 * stage; the size/format fields feed the predicate's `artifact` record.
 */
export interface DiskInfo {
  /** SHA-256 of the input disk file (lowercase hex). */
  sha256: string
  /** On-disk size of the QCOW2 file in bytes (`fs.stat`). */
  sizeBytes: number
  /** Guest-visible virtual size in bytes (`qemu-img info` `virtual-size`). */
  virtualSize: number
  /** Host allocated size in bytes (`qemu-img info` `actual-size`). */
  actualSize: number
  /** QCOW2 compatibility level (`format-specific.data.compat`, e.g. `1.1`). */
  compat: string
}

// Shape of the `qemu-img info --output=json` document, restricted to the fields
// this stage reads.
interface QemuImgInfo {
  format?: string
  'virtual-size'?: number
  'actual-size'?: number
  'backing-filename'?: string
  'format-specific'?: { data?: { compat?: string } }
}

// Shape of the `qemu-img check --output=json` document.
interface QemuImgCheck {
  corruptions?: number
  'check-errors'?: number
}

/**
 * Validate a QCOW2 disk image structurally, read-only, and return the facts the
 * predicate needs. The input file is never modified. Fails closed with a
 * distinct message for each rejection: a missing/irregular file, a non-QCOW2
 * format, an unexpected backing file, or a corrupt image.
 */
export async function validateDisk(path: string): Promise<DiskInfo> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(path)
  } catch {
    throw new Error(`Disk path "${path}" does not exist.`)
  }
  if (!stat.isFile()) {
    throw new Error(`Disk path "${path}" is not a regular file.`)
  }

  const infoResult = await exec('qemu-img', ['info', '--output=json', path])
  const info = JSON.parse(infoResult.stdout) as QemuImgInfo

  if (info.format !== 'qcow2') {
    throw new Error(
      `Disk "${path}" is not a QCOW2 image: qemu-img reports format "${
        info.format ?? 'unknown'
      }". Only qcow2 is supported.`
    )
  }

  const backing = info['backing-filename']
  if (backing) {
    throw new Error(
      `Disk "${path}" has an unexpected backing file "${backing}"; ` +
        'backing files are not supported in v1.'
    )
  }

  const checkResult = await exec('qemu-img', ['check', '--output=json', path], {
    ignoreReturnCode: true
  })
  const check = JSON.parse(checkResult.stdout) as QemuImgCheck
  const corruptions = check.corruptions ?? 0
  const checkErrors = check['check-errors'] ?? 0
  if (checkResult.exitCode !== 0 || corruptions > 0 || checkErrors > 0) {
    throw new Error(
      `Disk "${path}" failed the qemu-img integrity check: ` +
        `${corruptions} corruption(s), ${checkErrors} check error(s), ` +
        `exit code ${checkResult.exitCode}. The image is corrupt.`
    )
  }

  return {
    sha256: await sha256File(path),
    sizeBytes: stat.size,
    virtualSize: info['virtual-size'] ?? 0,
    actualSize: info['actual-size'] ?? 0,
    compat: info['format-specific']?.data?.compat ?? ''
  }
}
