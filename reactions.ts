/**
 * react / unreact tool bodies, split out of server.ts so they can be
 * unit-tested with injected dependencies (server.ts opens a Socket Mode
 * connection on import).
 */

import { isNoReactionError } from './lib.ts'

type ReactionName = { channel: string; timestamp: string; name: string }

export interface ReactionDeps {
  web: {
    reactions: {
      add: (args: ReactionName) => Promise<unknown>
      remove: (args: ReactionName) => Promise<unknown>
    }
  }
  assertOutboundAllowed: (chatId: string, threadTs: string | undefined) => void
  journalWrite: (input: {
    kind: 'gate.outbound.allow' | 'gate.outbound.deny'
    outcome: 'allow' | 'deny'
    toolName: string
    sessionKey?: { channel: string; thread: string }
    input: { channel: string; thread_ts: string | undefined }
    reason?: string
  }) => void
}

export interface ReactionArgs {
  chat_id: string
  message_id: string
  emoji: string
  thread_ts?: string
}

type ToolResult = { content: Array<{ type: string; text: string }> }

// react / unreact operate on a specific message ts; the "thread" they
// engage with is whatever thread that message lives in. Callers that
// know the parent thread pass `thread_ts`; when omitted, fall back to
// channel-level opt-in or top-level delivery by passing undefined.
function gateReaction(toolName: 'react' | 'unreact', args: ReactionArgs, deps: ReactionDeps): void {
  const sessionKey =
    args.thread_ts !== undefined ? { channel: args.chat_id, thread: args.thread_ts } : undefined
  const input = { channel: args.chat_id, thread_ts: args.thread_ts }
  try {
    deps.assertOutboundAllowed(args.chat_id, args.thread_ts)
  } catch (outboundErr) {
    deps.journalWrite({
      kind: 'gate.outbound.deny',
      outcome: 'deny',
      toolName,
      sessionKey,
      input,
      reason: outboundErr instanceof Error ? outboundErr.message : String(outboundErr),
    })
    throw outboundErr
  }
  deps.journalWrite({ kind: 'gate.outbound.allow', outcome: 'allow', toolName, sessionKey, input })
}

export async function executeReact(args: ReactionArgs, deps: ReactionDeps): Promise<ToolResult> {
  gateReaction('react', args, deps)
  await deps.web.reactions.add({
    channel: args.chat_id,
    timestamp: args.message_id,
    name: args.emoji,
  })
  return {
    content: [{ type: 'text', text: `Reacted :${args.emoji}: to ${args.message_id}` }],
  }
}

export async function executeUnreact(args: ReactionArgs, deps: ReactionDeps): Promise<ToolResult> {
  gateReaction('unreact', args, deps)
  try {
    await deps.web.reactions.remove({
      channel: args.chat_id,
      timestamp: args.message_id,
      name: args.emoji,
    })
  } catch (err) {
    // Removing a reaction that is not there is the desired end state,
    // so treat it as success. Agents swap markers (👀 → 🧠 → ✅) and a
    // retried swap must not fail on the half that already happened.
    if (!isNoReactionError(err)) throw err
  }
  return {
    content: [{ type: 'text', text: `Removed :${args.emoji}: from ${args.message_id}` }],
  }
}
