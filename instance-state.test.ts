import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendInboundLog,
  ENGAGED_THREADS_FILE,
  INBOUND_LOG_FILE,
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

describe('inbound log', () => {
  test('appends one JSON line per record with a timestamp', () => {
    appendInboundLog(
      dir,
      { kind: 'deliver', chat_id: 'C1', ts: '1.1', thread_ts: '1.0', user_id: 'U1' },
      new Date('2026-10-01T00:00:00Z'),
    )
    appendInboundLog(dir, {
      kind: 'drop',
      chat_id: 'C1',
      ts: '1.2',
      reason: 'channel.require_mention',
    })
    const lines = readFileSync(join(dir, INBOUND_LOG_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({
      at: '2026-10-01T00:00:00.000Z',
      kind: 'deliver',
      chat_id: 'C1',
      ts: '1.1',
      thread_ts: '1.0',
      user_id: 'U1',
    })
    expect(lines[1].reason).toBe('channel.require_mention')
  })

  test('trims to the newest lines past the size cap', () => {
    const big = 'x'.repeat(500)
    for (let i = 0; i < 4500; i++)
      appendInboundLog(dir, { kind: 'drop', chat_id: 'C1', ts: `${i}.0`, reason: big })
    const lines = readFileSync(join(dir, INBOUND_LOG_FILE), 'utf8').trim().split('\n')
    expect(statSync(join(dir, INBOUND_LOG_FILE)).size).toBeLessThanOrEqual(2_000_000)
    expect(lines.length).toBeGreaterThan(1_000)
    expect(JSON.parse(lines[lines.length - 1]).ts).toBe('4499.0')
  })

  test('an unwritable state dir does not throw', () => {
    expect(() =>
      appendInboundLog(join(dir, 'missing', 'deeper'), { kind: 'deliver', chat_id: 'C', ts: '1' }),
    ).not.toThrow()
  })
})
