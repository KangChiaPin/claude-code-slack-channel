# kjb fork patches (KangChiaPin/claude-code-slack-channel, branch kjb/main)

Divergences from `upstream/main` (jeremylongshore/claude-code-slack-channel).
Read before rebasing on upstream so nothing silently disappears in a merge.

Verify with:

```
git log --oneline upstream/main..kjb/main
git diff upstream/main..kjb/main --stat
```

Fork carries **28 commits** ahead of upstream (as of 640adfd). The list
below groups them into functional clusters. Merges + reverts are noted
but not counted as separate patches.

## Cluster A — Owner role hook (host-side gating)

The foundational fork feature: derive an owner/contributor role from
each inbound Slack message and emit it via a filesystem hook so the
host (agent-seed) can enforce role-gated tool calls at Claude Code's
PreToolUse layer.

- `7bd59d9` — base feature: optional owner-role hook (env-configured,
  writes `.current-role` on inbound).
- `e6d42fc` → `587edc5` — thread_ts + timestamp in hook file
  (subsequently reverted; original writeRoleHookFileAtomic contract
  is what ships).
- `f00a69b` — `SLACK_ROLES_FILE` multi-owner map + peer-agent
  B-prefix hardcode + `role` field on journal events. Load-bearing
  security path (`gate()`, `deriveRoleForSender`, `loadRolesFile`).
- `ce04f6f` — code-review v6 findings sweep + orthogonal tests on the
  roles-map cluster.

**Files touched**: `server.ts`, `lib.ts`, `journal.ts` (schema),
plus test files.

**Rebase discipline**: this cluster is the deepest divergence. A
noisy merge that drops `deriveRoleForSender` or the `loadRolesFile`
map path silently breaks role enforcement upstream. Re-verify tests
after any rebase touches `gate()` or the inbound dispatcher.

## Cluster B — Attachment / forward flattening

Flattens Slack's `attachments[]` payloads (which is where "Forward"
lands the original body) into the inbound MCP text, so the agent
sees forwarded content without needing an extra tool call.

- `34cd08d` — initial feat: flatten Slack forward attachments into
  inbound text.
- `12c3863` — cap + provenance-wrap flattened forwards + tests.
- `41530bd` — tighten cap accounting.
- `8da7c91` — refactor: pull attach-merge into a helper (crap-score
  gate unblock).
- `12e8046` — fix: count `\n---\n` joiner into totalCap.
- `5f49aa2` — populate `meta.forward_source_url` from Slack canonical
  permalink (paired with agent-seed's forward-to-DM quick-memory
  flow).

**Files touched**: `lib.ts` primarily (`flattenSlackAttachments`),
`server.ts` for wiring, tests.

**Rebase discipline**: the cap logic is subtle; changes upstream
that touch `chunkText` or inbound length limits may interact.

## Cluster C — Owner-token read tools (sensitive)

Adds fork-only MCP tools that read Slack via the owner's user OAuth
token (`xoxp-`), gated by `access.userDmAllowlist` /
`access.userReadAllowAll`. Journals every read as
`gate.user_token.read`.

- `a3bb7c9` — `fetch_user_dms` — read DM history with a specific
  other user, allowlist-gated.
- `16b489f` — `fetch_user_conversation` — read any channel/DM the
  owner can see (only when `userReadAllowAll` is true).
- `2835653` — `list_user_conversations` — enumerate channels/DMs
  the owner can see (only under `userReadAllowAll`).
- `9671a13` — fetch tools include message reactions in output.
- `8a013eb` — document fork-only access fields in ACCESS.md.

**Files touched**: `server.ts` (tool registration + handlers),
`lib.ts` (access schema), `ACCESS.md`.

**Rebase discipline**: three tools all share the user-token OAuth
plumbing. If upstream refactors WebClient bootstrapping, verify all
three still get the user client wired.

## Cluster D — Interactive Block Kit output

Adds fork-only `reply_with_choices` MCP tool for owner-approval
buttons (Block Kit); the click callback returns as an MCP
notification. Used by agent-seed's `/approve-proposal` +
forward-to-DM quick-memory flows.

- `b27d261` — `reply_with_choices` tool.
- `dc0ef89` — `reply` defaults `stream=true` (opt-out).

**Files touched**: `server.ts` (tool + handler), `lib.ts`
(chunking with stream default), tests.

**Rebase discipline**: upstream's `reply` tool signature changes
here; a merge that pulls in an upstream `reply` refactor must
reconcile the stream default.

## Cluster E — Stream reply UX

- `c2c76e2` — stream-reply emoji reactions + visible interrupt
  suffix.
- `d71dca3` — sanitize interrupt suffix + remove in-flight
  reaction.

**Files touched**: `stream-reply.ts`.

## Cluster F — DM gate niceties

- `f3fbe51` — gate: optional canned reply for non-allowlisted DMs
  (helps operators discover the allowlist requirement).
- `a454354` — `deniedDmOwnerPing` + `deniedDmCooldownSec` — bot
  DMs the owner when a denied-DM comes in, with cooldown so it
  doesn't spam.

**Files touched**: `lib.ts` (gate), `server.ts` (owner ping),
schema in `lib.ts`.

## Cluster G — Stream-finalize obligation env-guard (Z-patch)

- `3c656f8` — 3-line env-guard in `maybeBeginDurableStream`
  (`server.ts:1550`): return null when
  `SLACK_DISABLE_DURABLE_STREAM=1`. Disables the ccsc-o7x.6
  stream-finalize obligation to avoid the poller-vs-stream
  double-post race.

**Files touched**: `server.ts` (3 lines).

**Rebase discipline**: single, small, well-labeled. If a merge
drops it, re-apply as a single hunk. Fleet wires the env in
`agent-seed/templates/topic-mcp.json` +
`agent-seed/tools/create-topic.sh` +
`agent-seed/tools/run-topic.sh` migration.

## Cluster H — deliveredThreads dual-key for top-level DMs

- `server.ts:3946` — `deliverEvent` now adds BOTH the raw
  `incomingThreadTs` key AND the `incomingThreadTs ?? ev.ts`
  fallback key to `deliveredThreads`. Symmetric with the
  sessionKey on the next line (which uses the ts-fallback
  form).

**Motivation.** Fresh top-level DM inbounds (`ev.thread_ts`
undefined) added only `<channel>\0` (empty thread slot) to
deliveredThreads. But the bot's session/notification carried
`thread = ev.ts`, and per agent-seed's framework `thread_ts`
derivation rule the reply used `thread_ts = ev.ts` → outbound
gate checked `<channel>\0<ts>` → MISS → reply refused. Symptom:
aetherscope bot (fresh DM, six independent top-level messages
from owner, zero threaded follow-ups) couldn't reply to any of
them. Long-lived DMs (microscopy-ai, aetherslide-genius) don't
hit this because their traffic funnels through one persistent
thread, which populates the key correctly on the FIRST threaded
reply.

**Files touched**: `server.ts` (2 lines).

**Rebase discipline**: if upstream refactors `deliverEvent` or
splits the deliveredThreads add out, re-apply both add() calls.
Cross-thread isolation invariant (ccsc-xa3.5/6) preserved —
bot in thread A → outbound to thread B still misses because
B's ts was never inbound-delivered.

## Housekeeping (not patches)

- `cf6feae`, `cb6fde0`, `a3e2a86` — upstream merge commits.
- `d717502` — branch rename `feat/owner-role-hook` → `kjb/main`.
- `640adfd` — added this file.

## Rebase checklist

1. `git fetch upstream && git rebase upstream/main`.
2. Walk each cluster above and confirm its files still carry the
   expected hunks. If a rebase drops a hunk, `git log` the specific
   commit and cherry-pick.
3. Run `bun run typecheck` + `bun test` and confirm both pass
   before pushing.
4. Update this file when a patch's location changes materially.
