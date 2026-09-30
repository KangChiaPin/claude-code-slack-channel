/**
 * Per-STATE_DIR state that must outlive one server process.
 *
 * 1. Socket lock — one inbound socket per Slack app.
 *
 *    Slack Socket Mode round-robins events across every open connection for
 *    an app token. A second process on the same STATE_DIR (a second Claude
 *    Code session that loaded the same .mcp.json, or a zombie that outlived
 *    its session) therefore silently takes a share of the inbound messages,
 *    and whatever it receives never reaches the session that answers.
 *
 *    The lock is a file holding the owner's pid. A process that finds a live
 *    owner stays outbound-only (reply / react still work over HTTPS) and
 *    polls, taking over when the owner exits. Polling instead of giving up
 *    matters on restart: the old process lingers a few seconds while the new
 *    one boots, and a new process that gave up would leave the channel deaf.
 *
 * 2. Engaged threads — mention-stickiness that survives a restart.
 *
 *    On a requireMention channel a thread becomes "engaged" once a human
 *    mentions the bot, and later messages in it are delivered without a new
 *    mention. Kept only in memory, every restart silently re-closed all open
 *    threads: a follow-up in a conversation from before the restart was
 *    dropped as `channel.require_mention`, and from the asker's side the bot
 *    simply stopped answering.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SOCKET_LOCK_FILE = 'socket.lock'
export const ENGAGED_THREADS_FILE = 'engaged-threads.json'

/** True when `pid` is a running process. Linux: also require that it is
 *  still a Slack server, so a recycled pid does not hold the lock forever. */
export function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM: exists but not ours to signal — still alive.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmd.includes('server.ts')
  } catch {
    return true // no /proc (macOS): kill(0) is the best evidence available
  }
}

export type LockResult = { acquired: true } | { acquired: false; holder: number }

/** Try once to take the socket lock for `pid`. A lock whose holder is dead
 *  (or unreadable) is taken over. */
export function tryAcquireSocketLock(
  stateDir: string,
  pid: number,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): LockResult {
  const path = join(stateDir, SOCKET_LOCK_FILE)
  if (existsSync(path)) {
    const holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    if (holder === pid) return { acquired: true }
    if (isAlive(holder)) return { acquired: false, holder }
  }
  // Write-then-rename so a concurrent reader never sees a half-written pid,
  // then read back: of two processes racing here, the last rename wins and
  // the other sees a pid that is not its own.
  const tmp = `${path}.${pid}.tmp`
  writeFileSync(tmp, `${pid}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  const now = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
  return now === pid ? { acquired: true } : { acquired: false, holder: now }
}

/** Release the lock only if we hold it. */
export function releaseSocketLock(stateDir: string, pid: number): void {
  const path = join(stateDir, SOCKET_LOCK_FILE)
  try {
    if (Number.parseInt(readFileSync(path, 'utf8').trim(), 10) === pid) unlinkSync(path)
  } catch {
    /* already gone */
  }
}

/** Load persisted engaged-thread keys, oldest first. A missing or corrupt
 *  file yields an empty list: losing stickiness is the pre-persistence
 *  behavior, never a reason to fail boot. */
export function loadEngagedThreads(stateDir: string, max: number): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, ENGAGED_THREADS_FILE), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((k): k is string => typeof k === 'string').slice(-max)
  } catch {
    return []
  }
}

/** Persist engaged-thread keys atomically, in insertion order. */
export function saveEngagedThreads(stateDir: string, keys: Iterable<string>): void {
  const path = join(stateDir, ENGAGED_THREADS_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify([...keys]), { mode: 0o600 })
  renameSync(tmp, path)
}
