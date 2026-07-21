/**
 * Unit tests for src/cleanup.ts.
 *
 * '@actions/core' is mocked via the shared fixture so warning() calls are
 * observable without emitting real workflow log lines.
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { CleanupRegistry } = await import('../src/cleanup.js')

describe('cleanup.ts', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  it('runs teardowns last-in-first-out', async () => {
    const order: number[] = []
    const registry = new CleanupRegistry()
    registry.add(() => {
      order.push(1)
    })
    registry.add(() => {
      order.push(2)
    })
    registry.add(async () => {
      order.push(3)
    })

    await registry.drain()

    expect(order).toEqual([3, 2, 1])
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('still runs teardown 2 when teardown 1 throws', async () => {
    const ran: string[] = []
    const registry = new CleanupRegistry()
    // Added first, so it runs LAST (LIFO); it must still run after the
    // later-added teardown throws.
    registry.add(() => {
      ran.push('teardown-2')
    })
    // Added last, so it runs FIRST; it throws.
    registry.add(() => {
      throw new Error('teardown-1 boom')
    })

    await registry.drain()

    expect(ran).toContain('teardown-2')
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('teardown-1 boom')
    )
  })

  it('warns on a non-Error teardown failure', async () => {
    const registry = new CleanupRegistry()
    registry.add(() => {
      throw 'string failure'
    })

    await registry.drain()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('string failure')
    )
  })

  it('is safe to drain twice and clears the registry', async () => {
    const ran: number[] = []
    const registry = new CleanupRegistry()
    registry.add(() => {
      ran.push(1)
    })

    await registry.drain()
    await registry.drain()

    expect(ran).toEqual([1])
  })
})
