import * as core from '@actions/core'

/** A teardown callback registered for deferred execution. */
export type Teardown = () => Promise<void> | void

/**
 * A registry of deferred teardowns (temp directories, libguestfs handles, FUSE
 * mounts) drained by the orchestrator in a `finally` block. Teardowns run
 * last-in-first-out, and each is isolated in its own try/catch so one failure
 * cannot strand the rest — a failing teardown is logged via `core.warning` and
 * draining continues.
 */
export class CleanupRegistry {
  private teardowns: Teardown[] = []

  /** Register a teardown to run during {@link drain}. */
  add(fn: Teardown): void {
    this.teardowns.push(fn)
  }

  /**
   * Run every registered teardown LIFO, catching and logging each failure. The
   * registry is cleared first, so a second call is a safe no-op and a teardown
   * registered during draining is not double-run.
   */
  async drain(): Promise<void> {
    const pending = this.teardowns
    this.teardowns = []
    for (let i = pending.length - 1; i >= 0; i--) {
      try {
        await pending[i]()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        core.warning(`Cleanup teardown failed: ${message}`)
      }
    }
  }
}
