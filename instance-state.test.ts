import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGAGED_THREADS_FILE,
  loadEngagedThreads,
  releaseSocketLock,
  SOCKET_LOCK_FILE,
  saveEngagedThreads,
  tryAcquireSocketLock,
} from './instance-state.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instance-state-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('socket lock', () => {
  test('first process acquires, and re-acquiring its own lock is a no-op', () => {
    expect(tryAcquireSocketLock(dir, 100, () => true)).toEqual({ acquired: true })
    expect(tryAcquireSocketLock(dir, 100, () => true)).toEqual({ acquired: true })
  })

  test('a second process is refused while the holder is alive', () => {
    tryAcquireSocketLock(dir, 100, () => true)
    expect(tryAcquireSocketLock(dir, 200, (p) => p === 100)).toEqual({
      acquired: false,
      holder: 100,
    })
    expect(readFileSync(join(dir, SOCKET_LOCK_FILE), 'utf8').trim()).toBe('100')
  })

  test('a dead holder is taken over — the restart case', () => {
    tryAcquireSocketLock(dir, 100, () => true)
    expect(tryAcquireSocketLock(dir, 200, () => false)).toEqual({ acquired: true })
    expect(readFileSync(join(dir, SOCKET_LOCK_FILE), 'utf8').trim()).toBe('200')
  })

  test('garbage in the lock file does not wedge the channel', () => {
    writeFileSync(join(dir, SOCKET_LOCK_FILE), 'not-a-pid')
    expect(tryAcquireSocketLock(dir, 300)).toEqual({ acquired: true })
  })

  test('release only removes our own lock', () => {
    tryAcquireSocketLock(dir, 100, () => true)
    releaseSocketLock(dir, 200)
    expect(tryAcquireSocketLock(dir, 200, () => true)).toEqual({ acquired: false, holder: 100 })
    releaseSocketLock(dir, 100)
    expect(tryAcquireSocketLock(dir, 200, () => true)).toEqual({ acquired: true })
  })

  test('the real liveness check treats this test process as not a Slack server', () => {
    // process.pid is alive but its cmdline has no server.ts, so a recycled
    // pid cannot pin the lock.
    writeFileSync(join(dir, SOCKET_LOCK_FILE), `${process.pid}\n`)
    expect(tryAcquireSocketLock(dir, 999999)).toEqual({ acquired: true })
  })
})

describe('engaged threads', () => {
  test('round-trips in insertion order', () => {
    saveEngagedThreads(dir, ['C1\u0000T1', 'C1\u0000T2'])
    expect(loadEngagedThreads(dir, 10)).toEqual(['C1\u0000T1', 'C1\u0000T2'])
  })

  test('keeps only the newest max keys', () => {
    saveEngagedThreads(dir, ['a', 'b', 'c'])
    expect(loadEngagedThreads(dir, 2)).toEqual(['b', 'c'])
  })

  test('missing or corrupt file is an empty set, not a boot failure', () => {
    expect(loadEngagedThreads(dir, 10)).toEqual([])
    writeFileSync(join(dir, ENGAGED_THREADS_FILE), '{oops')
    expect(loadEngagedThreads(dir, 10)).toEqual([])
    writeFileSync(join(dir, ENGAGED_THREADS_FILE), JSON.stringify(['ok', 3, null]))
    expect(loadEngagedThreads(dir, 10)).toEqual(['ok'])
  })
})
