# kjb fork patches (KangChiaPin/claude-code-slack-channel, branch kjb/main)

Divergences from `upstream/main` (jeremylongshore/claude-code-slack-channel).
Read before rebasing on upstream so nothing silently disappears in a merge.

## Active patches

### `maybeBeginDurableStream` env-guard — `SLACK_DISABLE_DURABLE_STREAM=1`

- Commit: `3c656f8` (2026-07-15).
- Location: `server.ts:1550-1558` (top of `maybeBeginDurableStream`, before the
  `supervisor === null` guard).
- Diff:

  ```
  async function maybeBeginDurableStream(...) {
  +  if (process.env.SLACK_DISABLE_DURABLE_STREAM === '1') return null
     if (supervisor === null || threadTs === undefined) return null
     ...
  ```

- Motivation: the ccsc-o7x.6 stream-finalize obligation races the outbox
  delivery poller on long streams, causing double-post. Upstream's model has
  no signal for "stream is currently in progress" that the poller can honour
  — pending obligation is indistinguishable from a crash-pending one.
- Trade-off: crash mid-stream leaves a partial Slack message with no
  redelivery. Acceptable for owner-driven fleets; the operator re-asks.
- Rebase discipline: if upstream refactors this function, the guard block
  above still applies AT THE TOP of whatever the replacement is called.
  Re-apply if the merge dropped it.
- Fleet wiring: `agent-seed/templates/topic-mcp.json` includes
  `SLACK_DISABLE_DURABLE_STREAM` in the plugin's env whitelist,
  `agent-seed/tools/create-topic.sh` seeds `=1` in every new bot.env, and
  `agent-seed/tools/run-topic.sh` migrates existing bot.envs on first run.

### Owner-role hook + `SLACK_ROLES_FILE` multi-owner map

- Commits: `5f49aa2`, `f00a69b`, and the fork-history predecessors.
- Locations across `server.ts` / `lib.ts` / `journal.ts`.
- See commit bodies for the full contract. This is the deepest divergence
  from upstream and is the reason `kjb/main` is not a candidate for a
  clean upstream PR.

### Slack forward-source-url extraction on `flattenSlackAttachments`

- Commit: `5f49aa2`.
- Location: `lib.ts` around `flattenSlackAttachments`.
- Populates `meta.forward_source_url` from Slack canonical permalinks
  inside forward attachments, used by agent-seed's `forward-to-DM
  quick memory` mechanism.

## Rebase checklist

1. `git fetch upstream && git rebase upstream/main`.
2. If conflicts land in `server.ts` around `maybeBeginDurableStream` — verify
   the env guard survived. If dropped, cherry-pick `3c656f8`'s hunk.
3. If conflicts land in the role-hook plumbing (`gate()`, `deriveRoleForSender`,
   `loadRolesFile`) — resolve carefully; those are load-bearing security paths.
4. Run `bun run typecheck` + `bun test` and confirm both pass before pushing.
5. Update this file if a patch's location changed.
