# Review wait loop

An external review bot can take minutes to answer. An agent that polls GitHub itself spends tokens on every check, and an agent without stop conditions can request reviews or "fix" the same finding forever. The [`prloop`](../tools/prloop/README.md) tool takes over the waiting and the gates, and tells the agent exactly what to do next. The agent still does the engineering work.

## The loop

1. **Implement** the change in the PR branch.
2. **Gate**: `prloop ready <pr> --gate "<cmd>"` runs the project's full gate on the clean, pushed head and marks it tested, at most once per clean tree and gate command (`--force-gate` reruns it; `prloop mark-tested --gate "<cmd>"` records a gate already run by hand on exactly that head as a self-reported pass, which a merge accepts only after gate-irrelevant changes from a pass prloop ran). Every gate run keeps its output, timing and exit status in a gate log that `prloop status`, `ready` and `run --status` name. Agents run it in the foreground and never run the full gate directly. It also passes only when no review thread is unresolved and no request is already pending on this head, and lists exactly what is missing otherwise. A repository with a long gate can declare it heavy in `.prloop.json` to pipeline review: the request goes out first and the gate runs in parallel on the same head, and a merge still needs both.
3. **Request**: post the review trigger comment once, for example `@codex review`.
4. **Wait**: prloop polls quietly until one verdict: `clean`, `findings`, `not_requested`, `requested_while_unresolved`, or `timeout` with the previous request text to repost. When the bot is unavailable, the default `auto` mode runs one read-only local review of the head and posts it, so the loop continues.
5. **Fix**: for findings, fix valid ones, reply with evidence to invalid ones, resolve addressed threads, and go back to step 2.

When GitHub reports the branch behind or conflicting with its base, `prloop sync <pr>` updates it from the freshly fetched base branch with the method the repository allows. Append-only files can be merged as a union of lines; with `regenerate` in `.prloop.json`, conflicts limited to generated files take the base side and are rebuilt by that command once at the end; any other conflict is aborted and handed back to an agent with the file list, which resolves it through `prloop sync <pr> --continue` instead of a raw rebase. A sync that needed no manual resolution and leaves the PR's own change identical (equal `git patch-id --stable`) carries the previous clean review to the new head, so it costs no new cloud review; the new head still needs the gate before a merge. `prloop run` syncs a behind head even when it is mergeable, so the gate covers the combined base-plus-branch state.

The recommended way to run the loop is one background supervisor, started as a direct background job of the coordinator's shell so its exit notifies, always with a deadline: `prloop run --repo <owner/name> --pr <N,...> --gate "<cmd>" --deadline 6h &`. Never supervise it through a detached process plus a `pgrep -f` watcher, which can match itself and never exit. It polls all PRs round-robin without a model, spawns a fresh agent only when there is work, and each agent does one step (fix, gate through `prloop ready`, reply and resolve, request) and exits. A coordinator checks in with `prloop run --status`, which reads local state and an event log, after one GitHub call per repository that marks PRs merged or closed outside a run in their state files; when that call fails (offline, unauthenticated), the states stay as they were and may be stale. Agents running `prloop wait` themselves is the manual alternative.

Several supervisors and unrelated work can share one machine safely, because resource awareness is on by default. Gates take one of `--gate-slots` (2) slots shared by all of the user's `prloop` processes (a gate declared light skips the queue while load allows), and no agent or gate starts while the 1-minute load average exceeds `--max-load` (0.75 x CPU cores) or available memory is below `--min-free-mem` (the larger of 4 GiB and 10% of RAM). A wait never deadlocks: after `--resource-wait` (30m) it proceeds with one slot only. `--gate-tmpdir <dir>` gives each gate, fix agent and local review a private, deleted-afterwards `TMPDIR` so a large suite or agent cannot fill a small `/tmp`. `prloop run --status` shows load, free memory and slots in use. See [Sharing one machine](../tools/prloop/README.md#sharing-one-machine).

One writer works in a worktree at a time. While `prloop run` has a fix agent or local reviewer working in a worktree it holds a lock in that worktree's Git directory, and `prloop ready`, `sync` and `mark-tested` from any other process exit 40 naming the holder. Coordinators respect the lock too: check `prloop lock-status <dir>` before handing a worktree to an agent. When parallel work would share a checkout, create a separate worktree per agent or PR (`git worktree add <dir> -b <branch> origin/<base>`, or `git worktree add <dir> <existing branch>`) and remove it after the merge.

## Why

- **Fewer tokens.** Polling, gating and syncing cost no model tokens. Agents start only when there is work, see only the current trigger, and exit after one step; a coordinator reads one compact status object.
- **Current-head evidence.** Only reactions, comments and reviews newer than the head commit or the current request count, matching [review signal interpretation](validation-and-review.md#codex-cloud-review-signals). Eyes, silence and an older thumbs-up are not a clean review.
- **No duplicate requests.** `ready` refuses while a request on the current head is still running; a request becomes repeatable only after it times out.
- **No infinite loops.** The optional `prloop run` supervisor stops with a `blocked` reason on a round limit (6 by default; at the cap the coordinator judges the remaining findings by real impact, merges low-risk leftovers as deferred, or resets the rounds once with `prloop reset-rounds` for important defects before handing over to a human), an overall deadline, an agent that makes no progress or reports a permission denial, or the same finding returning after two fixes.

Merging remains a separate, explicitly authorized step. `prloop run --merge` only merges a clean current head that GitHub reports mergeable, pinned with `--match-head-commit`.

## Origin

`prloop` replaces a much larger review queue that a private project ran and later retired. That queue clustered findings, ran its own repair workers, and tracked review budgets across rebases. The lessons that survived are small:

- A review is clean only on an explicit current-head signal with no new unresolved threads. Silence, eyes, timeouts, stale approvals and an earlier head's clean result are not clean.
- Resolve a thread only when the current code and validation show the finding is fixed or concretely invalid. An outdated anchor is not evidence.
- Retry transient GitHub errors, but fail closed on ambiguous state instead of starting over.
- Keep the agent responsible for the work and keep every loop bounded.
