import type * as execModule from '../src/exec.js'
import { jest } from '@jest/globals'

/**
 * Jest mock of `src/exec.ts` for downstream tests, so no test invokes a real
 * external binary. Mock per test with `exec.mockResolvedValue(...)`.
 */
export const exec = jest.fn<typeof execModule.exec>()
