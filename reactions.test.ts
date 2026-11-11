import { describe, expect, test } from 'bun:test'
import { executeReact, executeUnreact, type ReactionDeps } from './reactions.ts'

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code },
  })
}

function makeDeps(opts: { deny?: boolean; removeError?: Error } = {}) {
  const calls: Array<{ op: string; args: unknown }> = []
  const journal: Array<Record<string, unknown>> = []
  const deps: ReactionDeps = {
    web: {
      reactions: {
        add: async (a) => {
          calls.push({ op: 'add', args: a })
        },
        remove: async (a) => {
          calls.push({ op: 'remove', args: a })
          if (opts.removeError) throw opts.removeError
        },
      },
    },
    assertOutboundAllowed: (chatId, threadTs) => {
      calls.push({ op: 'gate', args: { chatId, threadTs } })
      if (opts.deny) throw new Error('outbound gate: not allowed')
    },
    journalWrite: (e) => {
      journal.push(e as Record<string, unknown>)
    },
  }
  return { deps, calls, journal }
}

const ARGS = { chat_id: 'D0OWNER', message_id: '1700000000.000100', emoji: 'eyes', thread_ts: '1700000000.000100' }

describe('executeUnreact', () => {
  test('gates on (chat_id, thread_ts), then removes the named reaction', async () => {
    const { deps, calls, journal } = makeDeps()
    const res = await executeUnreact(ARGS, deps)
    expect(calls).toEqual([
      { op: 'gate', args: { chatId: 'D0OWNER', threadTs: '1700000000.000100' } },
      { op: 'remove', args: { channel: 'D0OWNER', timestamp: '1700000000.000100', name: 'eyes' } },
    ])
    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({ kind: 'gate.outbound.allow', toolName: 'unreact' })
    expect(res.content[0].text).toBe('Removed :eyes: from 1700000000.000100')
  })

  test('no_reaction is success, so a retried swap does not fail', async () => {
    const { deps } = makeDeps({ removeError: slackError('no_reaction') })
    const res = await executeUnreact(ARGS, deps)
    expect(res.content[0].text).toContain('Removed :eyes:')
  })

  test('other Slack errors still surface', async () => {
    const { deps } = makeDeps({ removeError: slackError('message_not_found') })
    await expect(executeUnreact(ARGS, deps)).rejects.toThrow('message_not_found')
  })

  test('gate deny: journals the deny, throws, never calls Slack', async () => {
    const { deps, calls, journal } = makeDeps({ deny: true })
    await expect(executeUnreact(ARGS, deps)).rejects.toThrow('outbound gate')
    expect(calls.map((c) => c.op)).toEqual(['gate'])
    expect(journal[0]).toMatchObject({ kind: 'gate.outbound.deny', outcome: 'deny', toolName: 'unreact' })
  })

  test('without thread_ts the gate gets undefined and no sessionKey is journaled', async () => {
    const { deps, calls, journal } = makeDeps()
    await executeUnreact({ chat_id: 'C1', message_id: '1.2', emoji: 'brain' }, deps)
    expect(calls[0]).toEqual({ op: 'gate', args: { chatId: 'C1', threadTs: undefined } })
    expect(journal[0].sessionKey).toBeUndefined()
  })
})

describe('executeReact (unchanged behaviour after the move)', () => {
  test('gates, then adds the reaction, journaling as react', async () => {
    const { deps, calls, journal } = makeDeps()
    const res = await executeReact({ ...ARGS, emoji: 'brain' }, deps)
    expect(calls.map((c) => c.op)).toEqual(['gate', 'add'])
    expect(journal[0]).toMatchObject({ kind: 'gate.outbound.allow', toolName: 'react' })
    expect(res.content[0].text).toBe('Reacted :brain: to 1700000000.000100')
  })

  test('gate deny: no Slack call', async () => {
    const { deps, calls } = makeDeps({ deny: true })
    await expect(executeReact(ARGS, deps)).rejects.toThrow()
    expect(calls.map((c) => c.op)).toEqual(['gate'])
  })
})

describe('marker swap 👀 → 🧠 → ✅', () => {
  test('replaying the full swap leaves exactly ✅ even when a removal repeats', async () => {
    const present = new Set(['eyes'])
    const deps: ReactionDeps = {
      web: {
        reactions: {
          add: async (a) => {
            if (present.has(a.name)) throw slackError('already_reacted')
            present.add(a.name)
          },
          remove: async (a) => {
            if (!present.delete(a.name)) throw slackError('no_reaction')
          },
        },
      },
      assertOutboundAllowed: () => {},
      journalWrite: () => {},
    }
    const on = (emoji: string) => ({ ...ARGS, emoji })
    await executeUnreact(on('eyes'), deps)
    await executeReact(on('brain'), deps)
    await executeUnreact(on('brain'), deps)
    await executeUnreact(on('brain'), deps) // retried half of the swap
    await executeReact(on('white_check_mark'), deps)
    expect([...present]).toEqual(['white_check_mark'])
  })
})
