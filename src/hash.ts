import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Compute the SHA-256 of a file by streaming it, so arbitrarily large disk
 * images are never buffered whole in memory. Returns lowercase hex.
 */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Compute the SHA-256 of an in-memory buffer. Returns lowercase hex. */
export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
