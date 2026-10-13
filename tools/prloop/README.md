# prloop

`prloop` keeps pull requests moving through an external reviewer bot while spending as few model tokens as possible. A plain script does all the polling, gating and syncing; a fresh coding agent is started only when there is real work (findings, a conflict, a missing or timed-out review request, a local review), finishes that one step and exits. The agents do the engineering: fixing code, running tests, replying to and resolving threads, and posting the review request.

The default reviewer is the Codex GitHub connector (login `chatgpt-codex-connector`, triggered by a `@codex review` comment). Any bot with a similar request-and-react pattern can be configured.

The tool is one Node.js ES module with no dependencies. It needs Node 20+, Git and an authenticated [GitHub CLI](https://cli.github.com/) (`gh`).

## Install

```bash
ln -sf "$PWD/bin/prloop" ~/.local/bin/prloop   # run from the repository root
prloop --help
```

`bin/prloop` is a symlink to `tools/prloop/prloop.mjs`. Run the tests with `node --test` from the repository root; they use fixture JSON and temporary Git repositories and never contact the network.

The installed copy should be a checkout that tracks the published `main`; changes go through PRs, not local edits. On startup `run` and `ready` check prloop's own checkout (the directory of the resolved script, when it is a Git repository): it must be clean, on the default branch (`origin/HEAD`, else `main`) and not behind `origin`, read with `git ls-remote` so nothing in the checkout is written (10s timeout; a failed read skips this part with a note). Otherwise they print one `self_check` warning on stderr naming the fix, `git -C <dir> pull --ff-only`. With `--require-current` (or `PRLOOP_REQUIRE_CURRENT=1`) the warning becomes a usage error (exit 40). A copy outside Git is not checked.

## Sharing one machine

Several `prloop` processes, their agents and gates, and unrelated work often share one machine. Resource awareness is on by default. These limits are one machine-wide setting: set them once in `${XDG_STATE_HOME:-~/.local/state}/prloop/config.json`, which every `prloop` process of the user reads (keys `gateSlots`, `maxLoad`, `minFreeMem`, `resourceWait`, `gateTmpdir`, `quotaWindow` and `reviewerBackoff` (see [reviewer quota memory](#reviewer-quota-memory)), and `approvedRegenerate`, see [syncing](#syncing-with-the-base); for example `{"gateSlots": 4, "gateTmpdir": "/var/tmp"}`). The environment overrides the file and a flag overrides both. `run` passes its effective gate, gate weight, limits and `reviewBeforeGate` to every agent it spawns, so the agent's own `prloop ready` uses the same values.

| Option | Environment | Default | |
|---|---|---|---|
| `--gate-slots <n>` | `PRLOOP_GATE_SLOTS` | 2 | Gates running at once, across every `prloop` process of the user. Each gate claims a slot in `/tmp/prloop-slots-<uid>/`, one directory per user whether or not the session sets `XDG_RUNTIME_DIR` (it must be yours and not writable by others) with a file named after the slot and its PID, and keeps it only when no other live claim exists, so racing claims never share a slot. Claims of dead processes, or whose PID now names another process (the claim holds the owner's start time on Linux), are removed; the claim also records the gate shell, so a gate that outlives a killed `prloop` keeps its slot until it ends. A waiting gate polls quietly, rechecks the load and memory limits on every poll, and logs one `waiting_for_gate_slot` event. |
| `--max-load <x>` | `PRLOOP_MAX_LOAD` | 0.75 x CPU cores | No agent, local review (also one started by `wait`) or gate starts while the 1-minute load average is higher. |
| `--min-free-mem <size>` | `PRLOOP_MIN_FREE_MEM` | larger of 4G and 10% of RAM | ...or while available memory (`MemAvailable` on Linux, free memory elsewhere) is lower. Sizes take K, M, G or T (binary). |
| `--resource-wait <dur>` | `PRLOOP_RESOURCE_WAIT` | 30m | The wait never deadlocks: after this long it proceeds with one slot only (one agent at a time in `run`, only the first gate slot in `ready`) and logs `resource_wait_expired`. |
| `--gate-tmpdir <dir>` | `PRLOOP_GATE_TMPDIR` | off | Runs each gate, fix agent and local review with `TMPDIR` set to a private directory that prloop creates under `<dir>` for that run and deletes afterwards, so a test suite does not fill a small RAM-backed `/tmp` and leaves no scratch behind. prloop's own scratch for an agent or reviewer (codex output and schema files) goes there too. |

A gate's slot cost comes from its [weight](#per-repository-config-prloopjson): a heavy gate (the default) takes one slot, a gate declared with a slot count takes that many (all at once or none), and a light gate takes no slot while load and memory allow, so a two-minute gate never waits behind 25-minute gates of another repository. After an expired resource wait a light gate queues for the one slot like any other.

Resource checks repeat every `--interval`; one `waiting_for_resources` event with the load, its limit, free memory and its limit is logged per wait (in the run log for `run`, on stderr for `ready`). `prloop run --status` adds one `machine` line: load, free memory and gate slots in use. To turn a limit off in practice, raise it (for example `--gate-slots 64`).

Once a PR exists, agents run its full gate only through `prloop ready`, so the gate slots and the load and memory limits apply; running the full check directly bypasses them. Focused test runs are fine. Work without a pushed PR head (before publication, or local-only) runs the gate directly, once per exact clean head (again after fixes or any new commit, even one that leaves the tree unchanged), and only while the machine's load and free memory are within those limits. Because every loop waits on the gate, fixes to a repository's own test tooling (its gate, test suites and test infrastructure, such as flaky or slow tests), and work that makes its gate runs cheaper or faster (cheaper test setup, removing redundant gate work), get the same priority as prloop and playbook fixes.

Gates and agents each run in their own process group. On an agent timeout, and when prloop itself gets SIGINT, SIGTERM or SIGHUP, prloop sends TERM to each whole group and KILL to whatever is left 5 seconds later, so test workers and services a gate started do not outlive it; a signalled prloop then removes its scratch and exits with 128 plus the signal number (130, 143, 129). Children run in their own groups, so a terminal Ctrl-C reaches only prloop; a second signal during that grace period sends KILL to every group at once. Its private temp dirs (`prloop-gate-*`, `prloop-agent-*`, `prloop-review-*` under `--gate-tmpdir`, else the system tmpdir) are named after their owner (`<prefix><pid>.<start>.<pid namespace>-XXXXXX`). On startup `run` and `ready` remove this user's dirs whose owner process is gone (a `reclaimed_tmp` event on stderr), and never touch one whose owner is alive or sits in another PID namespace (a sandboxed agent's gate, which a check from outside cannot see); a dir without an owner in its name predates this and is removed once it is older than 24 hours. `prloop run --status` adds one `tmp` line: dirs in use, dirs left over by dead owners, and what the last reclaim removed. When prloop dies without running its handler (SIGKILL, a crash), a small detached watcher it started with its first child sees prloop's pipe close and stops the child groups it still had the same way (TERM, then KILL 5 seconds later).

## Per-repository config (`.prloop.json`)

A repository declares its own gate in `.prloop.json` at its root, so a coordinator does not repeat long `--gate` and `--union` strings, and the repository's AGENTS.md can point to it:

```json
{ "gate": "npm run check", "gateWeight": "heavy", "union": ["CHANGELOG.md"], "merge": "squash", "reviewBeforeGate": true,
  "generated": ["src/generated/**"], "regenerate": "npm run generate" }
```

| Key | |
|---|---|
| `gate` | The full validation command (`--gate`, `PRLOOP_GATE`). |
| `gateWeight` | `light` (a short gate: no slot while load allows), `heavy` (one slot), or a slot count (`2`, at most `--gate-slots`; a number below 1 counts as light). Unset means one slot. `--gate-weight`, `PRLOOP_GATE_WEIGHT`. |
| `union` | Globs that `sync` merges as a union (`--union`). |
| `generated` | Globs of generated files, in addition to files that `.gitattributes` marks `linguist-generated` on either side. |
| `regenerate` | A command, or a list of commands run in order, that rebuilds the generated files (an empty list or a blank command is rejected). With it, `sync` [resolves conflicts limited to generated files itself](#syncing-with-the-base). |
| `gateIrrelevant` | Globs of paths whose changes do not affect the gate (for example `["docs/**", "*.md"]`). `run --merge` accepts a [self-reported pass](#gate-logs-and-pass-provenance) only on a head whose diff from a prloop-run pass of the same gate touches nothing else; a changed submodule or `.prloop.json` never counts as irrelevant, and the list is read from the checked-out head each time. Unset means every path counts. |
| `merge` | The merge method used by `run --merge repo`. Merging itself still needs that explicit flag. |
| `reviewBeforeGate` | [Pipelined review](#pipelined-review); defaults to on for a declared heavy gate (`heavy` or a slot count of 1 or more), off otherwise. `--review-before-gate true\|false`, `PRLOOP_REVIEW_BEFORE_GATE`. |

`prloop` reads the file of the repository that holds the current directory (or `--worktree` for `run`); unknown keys or wrong types are a usage error (exit 40). A flag overrides the environment, which overrides the file.

### Pipelined review

With a heavy gate (20+ minutes plus slot waits), gating before every review request leaves the cloud reviewer idle. With `reviewBeforeGate`, each round runs the two in parallel on the same head:

1. The fix agent pushes and resolves the addressed threads. `prloop ready` then checks everything except the gate and, while the head still needs a request, does not run the gate (`"gate": "deferred"`); the agent posts the request. Only a head with neither a request nor a bot answer (👀, a result, or an unavailable or quota reply) defers: once either exists, `ready` runs the gate, even when the head may be requested again after a timeout or an unavailable reply. A request already pending on the head, or a reviewer that already reviewed it, still blocks a new request.
2. `run` runs the full gate on that head itself, while it keeps polling the other PRs. Outside `run`, calling `prloop ready` again after the request runs the gate (it then reports `"gate": "passed"` and not ready, because the request is pending).
3. A merge (and the terminal `clean` of `run`) needs both a clean review and a passed gate on the same head. Findings start the next round as usual; a gate failure starts it with trigger `gate_failed`; the gate's last lines go to an owner-only local log whose path is in the PR state (`gateFailure.log`), and neither the output nor that path reaches the fix prompt, since the output may hold a secret and the agent reads the files a prompt references. The agent reruns the gate's steps locally instead. A failed gate after a request costs one round, which is acceptable because the previous round's gate usually passed and fixes are small.

`--reviewer local` always gates first, since a local review needs a tested head. Repositories whose AGENTS.md requires the gate before a review request should update that wording when they turn this on.

## Recommended workflow: one background supervisor

A coordinator (a person or an orchestrating agent) starts one supervisor for a set of PRs and checks in rarely:

```bash
prloop run --repo owner/name --pr 42,43,44 --gate "npm test" --merge squash --deadline 6h &   # runs until every PR is done
prloop run --status --repo owner/name                                          # cheap check-in, at most one GitHub call per repo
```

`run` polls every PR round-robin every `--interval`, in one process, and shares the machine with other work by default (see [Sharing one machine](#sharing-one-machine)). It syncs a branch that GitHub reports behind or conflicting (see [Saving cloud reviews](#saving-cloud-reviews)), waits for the reviewer, runs local reviews when needed, and spawns a fix agent only for findings, a manual conflict, a missing request, a timed-out request or a local-review gate gap. At most `--max-agents` (2) agents or local reviews run at once. It never needs the coordinator between steps and exits only when every PR is `merged`, `closed`, `merge_pending`, `clean` (without `--merge`), `blocked`, `needs_human`, `needs_agent` (with `--agent none`) or past the `--deadline` (6h). It then prints one JSON line per PR: `verdict`, `reason`, last `head`, `rounds`, and `next`, what a human or the coordinator must do.

Run `prloop run` as a direct background job of the coordinator's own shell (as above), so its exit notifies the coordinator, and always pass `--deadline`. Subagents that a coordinator starts with its own agent tooling (not through `prloop run`) may have a per-command time cap, such as 10 minutes: their briefs must run long commands such as `prloop ready` with a full gate as a background job and wait for it to exit, never in the foreground. Agents spawned by `prloop` itself get a shell timeout as long as `--agent-timeout` instead. Never supervise it through a detached process plus a `pgrep -f` watcher: the watcher's own command line can match its pattern, so it never sees the run end. After a tool failure (an agent that crashed, timed out or hit a missing tool or permission, not real review rounds), read the agent log named in the event and clear that PR's state file before rerunning, instead of spending `reset-rounds`.

Each PR's state lives in `${XDG_STATE_HOME:-~/.local/state}/prloop/<owner>__<name>__<pr>.json`, and every state change is appended to that run's `run-<time>.jsonl` event log in the same directory. `prloop run --status` prints all PR states as one JSON object, each with its last five events from the run log that state names. Each PR state also keeps `usage` totals over its fix agents and local reviews: `agentRuns`, `turns`, `costUsd`, `inputTokens` (including cache creation and cache reads) and `outputTokens`, read from the claude CLI's JSON wrapper (`num_turns`, `total_cost_usd`, `usage`) when each one ends. `run --status` and the final summary line of each PR show them. An agent whose output carries no usage, such as `codex exec` as prloop runs it, counts in `agentRuns` and leaves the other values blank (`null`) until a run reports them. `run --status` and the start of `run` first ask GitHub, in one call per repository, about every PR whose state is not yet `merged`, and mark those merged or closed outside a run accordingly, so `blocked` entries are live; a `closed` PR reopened on GitHub gets back the phase it had before it closed (`reopened` when a run recorded the close); when that call fails (offline, unauthenticated), the states stay as they were. Each state write is a read-modify-write under a one-slot claim in `<state>.json.lock.d` (a dead owner's uniquely named claim is removed, never a live one), so a reconciliation never overwrites newer rounds, findings or usage that a running supervisor saves, and a merged or closed phase it records stays when that supervisor later saves a stale agent or gate result; a run saves each phase and appends its event under that same claim, so a reconciliation cannot land between them and leave a stale phase as the newest event. Rounds and seen findings persist across runs on purpose; `prloop reset-rounds <pr>` resets the rounds once (see [At the round cap](#at-the-round-cap)), and deleting a PR's state file resets everything.

### Saving cloud reviews

Every cloud review costs quota, so `run` avoids requesting one when the PR's own change has not changed:

- **Behind but mergeable.** A PR `BEHIND` its base is synced even when GitHub reports it `MERGEABLE`, so the gate (`prloop ready`) runs on the combined base-plus-branch state before `--merge`; a tested marker of the old branch head never clears a merge. An unchanged patch carries the clean review (below), so this costs no new cloud review.
- **Carry-over after a sync.** When `sync` (or `run` calling it) updates a branch without any manual conflict resolution and the previous head was reviewed clean, it compares `git patch-id --stable` of the PR's own change (`<base>...<head>`) before and after. If they are equal, the clean verdict carries over to the new head instead of a new review request. Files merged as a union (`--union`) are compared without context lines, so the base's appended lines do not count as a change, while a line the union brought back does. The carry-over (old head, new head, patch-id) is recorded in the PR's state file and the event log, and `status`, `wait`, `ready` and `run` treat the new head as reviewed clean until a real review of that head says otherwise; a new review request on the new head supersedes the carry-over, so that review stays pending until its own cycle completes. A manual conflict resolution, a changed patch-id or new findings still need a new review. The new head still needs the gate (`prloop ready`) before a merge.

### Fix agents

Each fix agent runs in the PR's worktree (found with `git worktree list` by branch name, or `--worktree <path>`; either must have the PR branch checked out with HEAD at exactly the PR head and no uncommitted, untracked or dirty-submodule changes). Its prompt carries only the current trigger, never the round history: repository, PR, branch, head, worktree, the trigger (`findings`, `conflict`, `not_requested`, `timeout`, `local_review`), its data (compact findings with thread id, path, line and body; the conflicted files; or the previous request body), and the gate command. In one session it must:

1. read only the referenced files plus every AGENTS.md that applies to them (root and nested);
2. fix each valid finding with a regression test, reply with evidence on invalid ones and leave them unresolved (except a finding proven to misread AGENTS.md, which it resolves after the evidence reply once every AGENTS.md that applies to its path confirms it is invalid), resolve conflicts;
3. run focused tests while fixing, never the full project gate directly, then commit and push normally (`prloop sync` first if the base moved) with plain separate `git add <paths>`, `git commit` and `git push` commands (never chained, never `git add -A`), following the repository's commit-message policy and never adding attribution trailers;
4. resolve the fixed threads and reply on the disputed ones;
5. run `prloop ready`, which runs the gate (with [pipelined review](#pipelined-review) only once the request is posted, and `run` does that itself), in the foreground with a timeout of at least `--agent-timeout`, never backgrounded; after a gate failure, rerun the failing tests or step with their focused command and fix them, including failures it did not cause, before calling `prloop ready` again (at most 5 calls; blocked only when the same failure survives 3 consecutive fixes or the cause is environmental, such as a missing tool, no network or a permission denial);
6. post the review request, reusing the previous request body (skipped with `--reviewer local`);
7. end its final message with one JSON line on its own line, also when blocked (a denied action is reported as `blocked` naming the exact refused step, with the work left as it is for the coordinator to finish): `{"status":"requested|blocked|nothing_to_do","head":"…","fixed":[…],"disputed":[…],"reason":"…"}`.

prloop finds that line anywhere in the agent's final message, also pretty-printed inside a ```` ```json ```` fence, and with `--output-format json` searches the CLI's `result` field. The raw stdout and stderr of each fix agent and local reviewer are kept, owner-only, in `${XDG_STATE_HOME:-~/.local/state}/prloop/agents/<owner>__<name>__<pr>__<UTC time>.log`; `run`, `ready` and `wait` delete logs older than 14 days on startup. The path is in the event, the state (`agentLog`) and the final summary. When an agent ends without a result line, the reason names what the CLI JSON wrapper reports: the error `subtype` (such as `error_max_turns` or `error_during_execution`) or `is_error`, `api_error_status`, each permission denial (tool name and a short input) and a `terminal_reason` other than `completed`; otherwise the last 300 characters of the final message; if the agent made progress anyway (a new head, a resolved thread, a review request or a tested head), prloop logs `agent_no_result` and keeps polling instead of blocking. A result line that makes progress and carries a `reason` (such as a proposed prloop issue) is logged as an `agent_reason` event, shown by `run --status`, so the coordinator sees it.

Only one writer works in a worktree at a time. Before it spawns a fix agent or local reviewer, `run` takes a lock in the worktree's Git directory (`$(git rev-parse --git-dir)/prloop-lock/`, one claim file holding PID, process start time, start date and purpose) and releases it when the spawn ends; the agent inherits the claim's token as `PRLOOP_LOCK_TOKEN`. While another live process holds the lock, `prloop ready`, `sync` and `mark-tested` without the matching token exit 40 naming the holder, and `run` skips that PR's poll (also its own sync and the worktree checks, since the holder may have uncommitted work) and logs one `worktree_locked` event. `run` takes the lock around its own automatic sync too, and a standalone `prloop sync` or `prloop ready` takes it for its whole run unless its token already owns it, so `run` waits for a gate in progress instead of spawning a fix agent or charging a round. `prloop ready` rereads the PR after its gate, so a head pushed while the gate waited or ran is reported as not tested. The claim also records the spawned agent, so it stays held while an agent whose `prloop` was killed still runs. A claim whose processes all died, or whose PIDs now name other processes, is reclaimed.

Coordinators respect the lock too: check `prloop lock-status [<dir>]` (exit 50 and the holder when locked) before handing a worktree to an agent. When parallel work would share a checkout, give each agent or PR its own worktree, `git worktree add <dir> -b <branch> origin/<base>` for new work or `git worktree add <dir> <existing branch>`, and remove it with `git worktree remove <dir>` after the merge.

Fix agents never wait for or poll reviews, merge, touch other PRs, rewrite history except through `prloop sync`, or retry in a loop.

| Option | Default | |
|---|---|---|
| `--gate "<cmd>"` | `PRLOOP_GATE` | The project's full validation command, run by `prloop ready`. Without it the agent passes the gate documented in AGENTS.md or README to `prloop ready --gate`. |
| `--agent claude` | yes | `claude -p <prompt> --model claude-opus-5-5 --effort medium --permission-mode auto --output-format json`, run in the worktree so the CLI loads that project's instructions. |
| `--agent codex` | | `codex exec` with a workspace-write sandbox that allows network access. |
| `--agent none` | | Stops the PR at `needs_agent` with the generated `prompt` in its summary, so the coordinator can spawn its own agent and rerun `run`. A needed local review stops the PR at `blocked` instead of running a reviewer. |
| `--agent-timeout 90m` | 90m | `PRLOOP_AGENT_TIMEOUT`. Stops a fix agent or local reviewer (its whole process group: TERM, then KILL after 5 seconds) that works longer and records it `blocked` with `agent timed out after <budget> of work`, adding `with no output` when it printed nothing (the session was killed before its result; check its last command). Time its own `prloop ready` spends queued for the gate (the per-head gate lock, resource admission, a gate slot) is not counted: `run` passes `PRLOOP_QUEUE_FILE`, which `ready` holds while it waits, and the clock stops while that file names a live process. Claude agents also get `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` set to this budget: Claude Code otherwise moves a long Bash command such as the gate to the background after its default timeout, and a `-p` session then ends before the gate completes. Codex has no such setting, so its prompt carries only the foreground rule. |
| `--model`, `--effort` | | Override the agent model and effort (`PRLOOP_MODEL`, `PRLOOP_EFFORT`). |
| `--max-agents 2` | 2 | Agents and local reviews running at the same time. |
| `--max-rounds 6` | 6 | Fix-agent rounds per PR, across runs. |
| `--deadline 6h` | 6h | Overall run deadline. |
| `--merge rebase\|squash\|merge\|repo` | off | `repo` takes the method from `.prloop.json`. With `rebase`, `run` syncs by rebase, and when GitHub refuses a rebase merge of a PR it reports clean because of merge commits (or a branch it cannot rebase) it syncs (linearizes) once and retries; the linearized head needs the gate again. Any other merge refusal blocks with the original error, without rewriting the branch. Merges only a head whose fresh snapshot is clean with no unresolved threads, marked tested in the PR worktree with a clean pushed tree (with a gate, by a [prloop-run pass](#gate-logs-and-pass-provenance) or a covered self-reported one; otherwise prloop reruns the gate first), and reported mergeable, using `gh pr merge --match-head-commit <sha>`. A clean but untested head goes to an agent for the gate only. The result is `merged`, or `merge_pending` (exit 50) when a merge queue or auto-merge accepted it without merging yet. |
| `--union <glob>` | | Passed to sync. Reviewer and timing options apply as for `wait`. |

Failsafes end a PR in `blocked` (or `needs_human` for disputed findings) with a reason, never in a loop: maximum rounds per PR (`--max-rounds 6`), an agent that exits non-zero, prints no parseable result line without making progress, reports `blocked` or a permission denial (read from the CLI wrapper's `permission_denials` and the result line only; prose that quotes "permission denied" never blocks, and text is searched only when an agent has neither), or makes no progress (no new commit, resolved thread, request or tested head), the same finding (path plus normalized first line) returning after two fixes, the overall deadline, and every local-review failsafe.

Every count (`--max-rounds`, `--max-agents`) must be a positive integer and every duration (`--deadline`, `--interval`, `--timeout`, `--ack-timeout`, `--agent-timeout`) a positive `90s`/`40m`/`6h` value; anything else, such as `NaN`, `Infinity` or `0`, is a usage error (exit 40), as is a non-finite `--max-load`, instead of an unbounded loop. `--max-local-reviews` is a nonnegative integer: 0 disables local reviews.

### At the round cap

A PR that reaches `--max-rounds` stops as `blocked` with `max rounds (N) reached`. The coordinator then decides, without another automatic round:

1. Judge each remaining finding by its real impact on this change, not by the reviewer's severity label, and check the edge cases yourself: read the code path, the inputs that reach it, and whether a test covers it.
2. **Low-risk leftovers** (unlikely edge cases, hardening, wording): merge when authorized, reply on each thread that it is deferred and why, and record a follow-up (an issue or the next PR's task list).
3. **Important defects** (wrong results, data loss, security, broken contracts on a realistic path): run `prloop reset-rounds <pr> --repo owner/name` once and rerun `prloop run` for another full cap. The command only rewrites the PR's state file (`rounds: 0`, `roundResets: 1`) and logs a `rounds_reset` event; run it while no `run` is supervising that PR. A second reset is refused: if important defects still remain, hand the PR over to a human with the open threads.

### Agent memory in worktrees

Fix agents and local reviewers run in the PR's worktree, which may live outside the main checkout. With `--agent claude` this keeps the same per-project memory: Claude Code derives its auto-memory directory from the Git repository, so all worktrees of a repository share one. Instructions load from the worktree's own checked-out `CLAUDE.md` or `AGENTS.md`. Two things do not follow the agent into a worktree outside the main checkout: an untracked, gitignored `CLAUDE.local.md` (it exists only where it was created; import a file from your home directory instead) and instruction files in directories above the main checkout. Keep project rules in tracked files.

### One full gate per head

A passing gate is recorded in `${XDG_STATE_HOME:-~/.local/state}/prloop/gate-cache`, keyed by the exact HEAD of the clean checkout and the SHA-256 of its repository (Git common directory) and the gate command, so a rebase, amend or other repository with an identical tree still runs the gate. `ready --gate <cmd>` skips the gate only on such an exact hit for that command, never because the head was marked tested by another gate or by `mark-tested` without a gate; with a gate configured, `ready`, `status`, local reviews and the merge check of `run` also count the head as tested only by that hit. Concurrent `ready` runs for the same head and command check, run and record under one per-key lock in `gate-locks/` of the state directory, so only the first runs the gate and the others then hit its pass. On a hit `ready` marks the head tested and prints `gate already passed for head <sha>` on stderr; another worktree of the same repository at that head also hits. A dirty checkout never hits, a gate that changed the tree is not recorded, failures are never recorded, and `--force-gate` always runs it, even on a head already marked tested, which a failure then unmarks and evicts from the cache. Updates to both files hold an exclusive one-slot claim in `<file>.lock.d` (a dead owner's uniquely named claim is removed, never a live one), so a concurrent `ready` cannot restore a withdrawn mark or cache entry. Agents run focused tests while fixing and leave the full gate to `prloop ready`; when the gate command was already run by hand and passed on the current clean head, `prloop mark-tested --gate "<cmd>"` records it in the same cache, as a self-reported pass, instead of rerunning. Without `--gate`, `mark-tested` records the gate from `PRLOOP_GATE` or `.prloop.json`, if any, in the cache too.

### Gate logs and pass provenance

Every gate prloop runs writes its whole output (stdout and stderr, untrimmed) to `${XDG_STATE_HOME:-~/.local/state}/prloop/gates/<owner>__<name>__<pr>__<head>__<UTC time>.log`, owner-only, ending with a `# prloop: exit status N, <ms> ms, <start> to <end>` line; `run`, `ready` and `wait` delete gate logs older than 14 days on startup, like agent logs. Each run records its start, end, `durationMs`, exit `status`, log path and two sampled peaks (`peakLoad`, the 1-minute load average, and `peakRssMiB`, the resident memory of the gate's whole process tree, `null` without `/proc`) as the PR's `lastGate` in its state file, and as a `gate_run` event in its run log. `status`, `ready` and `run --status` show `lastGate` (a cached hit shows the pass it reused, with `cached: true`). A fix prompt gets neither the output nor the log path, since the output may hold a secret.

Each pass in the gate cache records its provenance: `source: "prloop"` for a gate prloop ran (with its log path, timing and exit status) or `source: "self"` for `prloop mark-tested --gate`, which runs nothing. `status` shows it as `gatePass`. Both let `ready` skip the gate, but `run --merge` accepts a self-reported pass only when the diff from a prloop-run pass of the same gate in the same repository touches only [`gateIrrelevant`](#per-repository-config-prloopjson) paths (`coveredBy` names that pass); otherwise it logs `gate_unverified` and runs the gate itself before merging (a failure goes to a fix agent like any gate failure). A cache line written by an older prloop has no provenance and counts as self-reported. Fix agents may use `mark-tested --gate` only right after running exactly that gate command on exactly that head.

## Agent-in-the-loop commands

The manual alternative, for an agent that drives one PR itself. Every command prints one JSON object on stdout; `--repo owner/name` defaults to the repository of the current directory.

| Command | Purpose | Exit codes |
|---|---|---|
| `prloop status <pr>` | Head SHA, unresolved threads (id, path, line, first 300 characters), latest trigger comment and whether it is newer than the head commit, reviewer state on the head (`none`, `reviewing`, `clean`, `findings`), `readyToRequest` with reasons, the head's gate pass with its [provenance](#gate-logs-and-pass-provenance) (`gatePass`) and the last gate run (`lastGate`). | 0, 40 |
| `prloop ready <pr>` | Gate before posting a review request, run inside the PR checkout. With `--gate` (or `PRLOOP_GATE`) it first runs the gate on the clean, pushed head and marks it tested; a failure prints the last 60 lines of output, and either result names the [gate log](#gate-logs-and-pass-provenance) and duration in `lastGate`. Then it passes only with no unresolved threads, no request already pending on the head, a tested head, and a clean tree on the PR branch whose `HEAD` equals the remote PR head, and lists exactly what is missing. | 0 ready, 50 not ready, 40 error or [worktree locked](#fix-agents) |
| `prloop mark-tested [--sha <sha>] [--gate "<cmd>"]` | Manual escape hatch: records that the gate passed for `HEAD` (or `--sha`); with a gate (`--gate`, `PRLOOP_GATE` or `.prloop.json`) and the clean `HEAD`, also in the [gate cache](#one-full-gate-per-head), as a [self-reported pass](#gate-logs-and-pass-provenance). Use it only right after running exactly that gate on exactly that head. Stored as `prloop-tested` in the Git common directory; never pushed. | 0, 40 |
| `prloop wait <pr>` | Polls every `--interval` (75s) until a verdict. A 👀 reaction means the bot is still reviewing. Posts nothing except a [local review](#local-reviewer-fallback) when one is needed. | see below |
| `prloop sync <pr> [--union <glob>]... [--continue]` | Brings the PR branch up to date with its base, inside the PR checkout; `--continue` finishes one with manual conflicts. See [Syncing with the base](#syncing-with-the-base). | 0, 40, 41 |
| `prloop lock-status [<dir>]` | Whether another process holds the [worktree lock](#fix-agents) of `<dir>` (default: the current directory), with its PID, purpose and start date. | 0 free, 50 locked |
| `prloop reset-rounds <pr>` | Resets the PR's round counter once, in the state file only, and logs it. See [At the round cap](#at-the-round-cap). | 0, 40 |

`wait` verdicts:

| Verdict | Exit | Meaning |
|---|---|---|
| `clean` | 0 | A [carried-over](#saving-cloud-reviews) clean verdict, or 👍 by the bot on the current request, but never on the PR body while a request is current (PR-body reactions carry no commit or request, so a late 👍 from an earlier review, even one posted after this cycle's 👀, cannot clear a new head), or (for an automatic review without a request) on the PR body after a 👀 there on this head, or a bot review on the head, or a bot comment matching the clean regex posted after the bot's 👀 on the current request or on the PR body after this head. Without a 👀, a clean comment after the current request also counts when it names this head (`Reviewed commit: <sha>`). A comment naming another commit never counts. When the bot reacts more than once, the latest reaction wins. |
| `findings` | 10 | Unresolved threads (path, line, up to 2000 characters of body) plus any reviewer summary on this head. |
| `not_requested` | 20 | No trigger comment after the current head commit. Run `prloop ready`, then request a review. |
| `requested_while_unresolved` | 21 | A request was posted while older threads were still open. |
| `timeout` | 30 | No reaction within `--ack-timeout` (3m) of the request, or no result within `--timeout` (40m). Both are measured from the request time, so running `wait` again does not restart the clock. Includes `rerequestBody`, a copy of your last trigger comment, to repost unchanged. A timed-out request no longer blocks `prloop ready`. |
| `unavailable` | 31 | Only with `--reviewer cloud`: the bot replied that it cannot review (usage limit, failure), or two requests on this head timed out. |
| `blocked` | 50 | A local review could not run or post, `--agent none` selects no reviewer, or its per-head or per-PR limit is used up. |
| `error` | 40 | GitHub could not be read three times in a row, bad input, or history prloop cannot fully see (more than 100 review threads, a review thread GitHub returned as null, or more than 100 comments since the head) so it fails closed. |

```bash
git push
prloop ready 42 --gate "npm test" && gh pr comment 42 --body "@codex review"
prloop wait 42                    # one call instead of dozens of polls
case $? in
  0)  echo "clean on the current head" ;;
  10) echo "fix findings, reply and resolve threads, then start again" ;;
  20) echo "request a review" ;;
  30) echo "repost rerequestBody" ;;
esac
```

## Syncing with the base

`prloop sync <pr>` runs inside a clean checkout of the PR branch whose `HEAD` equals the remote head. It fetches the base into `origin/<base>` (with an explicit refspec, so a single-branch clone updates it too), checks that `origin/<base>` contains the base commit GitHub reports for the PR (so a fork's stale branch is never used), compares and syncs against the fetched `origin/<base>`, never against that reported commit (GitHub's `baseRefOid` can lag far behind the base branch), and:

- merges the base when the repository allows merge or squash merges, then pushes normally;
- rebases onto the base when the repository allows only rebase merges, then pushes with `--force-with-lease=<branch>:<expected-sha>`, so it never overwrites commits it has not seen. A branch that already contains the base but has merge commits, which GitHub refuses to rebase-merge, is linearized the same way and reported with `linearized: true`. A rebase drops merge commits, so sync pushes only when the linearized tree equals merging the base into the old head (conflicts only in `--union` files are excluded from that comparison, since sync resolved them line by line, but every line the old head had in them must survive); when a merge commit carried its own edits it restores the old head and exits 40 instead.

Conflicts in files matching `--union` globs (append-only changelogs, CSV ledgers) are resolved as a union of both sides, base lines first, with identical lines kept once. A rebase replays the PR commit by commit, which could bring back a line a later PR commit deleted or keep a line twice, so after the sync each union file is set from both sides' end states and the difference committed: the base's version less the lines the PR deleted since the merge base, then the PR head's lines new since the merge base that the base lacks, again with identical lines kept once. The result holds no line that neither side had. A matching file that is a symlink on either side is never resolved this way, and a rebase whose later PR commit renamed or deleted a union-resolved file fails closed, for a merge by hand. So does any sync where a PR commit renamed, copied away or deleted a union-resolved path that exists again at the PR head, because the recreated file may be unrelated to the one the base changed. A move too small for git's copy detection (a few lines into a much larger new file) counts too: a PR commit that changes a union file and adds a file holding a line the union file lost fails closed the same way. Any other conflict aborts the merge or rebase, leaves the checkout as it was, and exits 41 with `verdict: "conflict"` and the conflicted files, for the agent to resolve by hand. Conflicted files that match `generated` in `.prloop.json` or that `.gitattributes` marks `linguist-generated` are listed again under `generated`, and the fix prompt tells the agent to regenerate them from their sources instead of merging them. Union resolution suits files where every line is an independent record; do not use it for files whose lines depend on order or on each other.

### Generated files

With `regenerate` in `.prloop.json`, a conflict in a generated file (matching `generated` or marked `linguist-generated`) takes the base side, and the merge or rebase continues; union files resolve as above. When every conflict was resolved this way, `regenerate` runs once at the end (each command through `sh -c`, in order), everything it changed is committed as one `Regenerate generated files after syncing with <base>` commit (`git add -A`), and the branch is pushed (with lease after a rebase). The result lists those files under `regenerated`. A failing command restores the old head, removes the untracked files it created (ignored ones included), and exits 40, naming the command and its exit status but not its output, which may hold a secret.

Any other conflict still aborts and goes to the fix agent. Spawned agents may not run a raw `git rebase` or `git merge`, so they finish through prloop: `prloop sync <pr> --continue` starts the sync like `sync` (a rebase always uses the merge backend) but leaves manual conflicts in the working tree (exit 41, `inProgress: true`; generated files already take the base side). The agent resolves them there, stages each resolution with `git add` or `git rm`, and runs `prloop sync <pr> --continue` again, which continues the merge or rebase it started (only one of this branch at the PR head onto the fetched base), refuses while any file is still unmerged (a binary or modify/delete conflict has no markers, so only staging counts as a resolution; files that still hold markers are named) or while an unstaged edit, an untracked file, or a staged change outside the files the step actually conflicted on (files Git merged cleanly must keep Git's result) is left over (none is ever committed along with the sync), stops again at the next conflicted commit, then runs `regenerate` (when set), commits and pushes like a plain sync. A resumed sync never carries a clean review over, and a linearizing rebase with manual conflicts fails closed. A regenerate that leaves uncommitted changes inside a submodule fails like a failed command, since they cannot be committed from the outer repository. Generated files are classified with `generated` and `regenerate` as the sync merged them, read from the working tree's `.prloop.json` (the caller's configuration applies while that file is itself conflicted, or when the repository never had one; a base that deleted it leaves no regenerate, so those conflicts go to the agent), so a base that changed either is honored at once; a file takes the base side only when the PR head's approved configuration (its committed `.prloop.json` and `linguist-generated` attributes, or the caller's lists without that file) also calls it generated, so a base that broadens `generated` never discards the branch's source unreviewed: those conflicts go to the agent. A regenerate command runs only when the PR head's committed `.prloop.json` already declares it (or the caller passed it, in a repository without that file), or when the PR's base is the repository's default branch, its committed `.prloop.json` declares it, and the operator approved every one of its commands for that repository in the machine file's `approvedRegenerate` (`${XDG_STATE_HOME:-~/.local/state}/prloop/config.json`, outside any repository, mapping `owner/name` to a list of commands, for example `{"approvedRegenerate": {"octo/app": ["npm run generate"]}}`; presence on the default branch alone does not prove review, and a command approved for one repository never runs in another, whose scripts may put anything behind it), so open PRs need not repeat it. Otherwise, when the base changed `regenerate`, the sync fails like a failed command and names the new command, so an unreviewed shell command never runs; inspect it, set the same `regenerate` on the branch and push (or approve it for that repository in `approvedRegenerate`), and rerun `prloop sync`. An invalid synced file fails every sync, with or without `regenerate`, before anything is pushed; one that no longer declares `regenerate` fails like a failed command and names the manual step. A rejected regeneration commit (for example a commit hook) also fails like a failed command, so no local merge with staged output is left behind. When `regenerate` fails after a manual resolution, the synced branch stays local and the error names its head.

A successful sync changes the head, so it clears the tested marker of the old head (markers of other PR heads stay): run `prloop ready` (which reruns the gate). Its output reports `treeUnchanged` (the new head has the same tree as the old one), `patchId`, `unchanged` and the union-merged files; when the old head was reviewed clean and `unchanged` is true it also reports the recorded `carry` and no new review is needed. Otherwise request a review.

## Local reviewer fallback

`--reviewer` (or `PRLOOP_REVIEWER`) selects who reviews:

| Mode | Behavior |
|---|---|
| `cloud` | Only the bot. An unavailable bot ends `wait` with `unavailable` (31). |
| `local` | Never asks the bot. `wait` runs a local review of the current head itself. |
| `auto` (default) | Uses the bot, and runs a local review when the bot replies that it cannot review or when two requests on the same head time out. An unavailable reply counts after the current request, or after the head when it was not requested, with or without a 👀: the bot posts its quota reply as a plain comment. The default regex matches quota and usage-limit replies such as "You have reached your Codex usage limits for code reviews", "usage limit reached" or "exceeded your ... quota", plus "couldn't complete this request" and "unable to review", but not a bare "quota" or "limit" in review text; set `--unavailable-regex` to change it. |

The local review is a separate, read-only agent run (`--agent claude` by default with `--permission-mode dontAsk` and only read and `git diff/log/show` tools; `--agent codex` uses `codex exec --sandbox read-only`), never the run that wrote the fix. It needs the same gate as a request: no unresolved threads, a tested head, and `wait` running inside a clean, pushed checkout of the PR branch. It reviews `git diff <base commit>...HEAD` from the base commit GitHub reports, and returns structured findings (path, line, severity P0-P3, body), which prloop posts with `gh` under your account (only results posted by the authenticated `gh` user count, so a copied prefix from someone else is ignored) as a normal PR review with inline comments, each prefixed `[local review]`; findings outside the diff go in the review body. A clean result posts `[local review] No issues found on <sha>.` The next poll classifies these exactly like bot results.

An unavailable reply never costs a round and never spawns a fix agent to re-request a review: the local review of that head runs first, also at the round cap, so a `max rounds` verdict only follows a real review of the final head.

### Reviewer quota memory

The cloud reviewer's quota belongs to the account, so once it replies that it is out of usage, every other PR would get the same reply (an automatic review on ready included). `run` remembers this across PRs and processes in `${XDG_STATE_HOME:-~/.local/state}/prloop/reviewer-state.json`: per repository owner and reviewer login (the bot login is the same everywhere, but each GitHub account or organization has its own quota), `blockedAt` (the newest quota reply) and `okAt` (the newest completed review), both GitHub timestamps, plus `okFrom` (the PR that showed that success). GitHub names the bot `x` on comments and `x[bot]` on reactions, so the login is keyed without a trailing `[bot]`; an entry written under `x[bot]` by an older prloop merges into `x` (newest wins) on the next write. Only a completed review counts as a success: a review submission or its thread comments, an issue comment matching `--clean-regex` (an explicit no-findings reply), or a 👍. 👀 and other bot comments, such as the Codex review summary posted when a review starts, do not. Each poll scans the PR's issue comments and their reactions, PR-body reactions, reviews and review-thread comments by the bot, ignores entries without a valid timestamp, and records what it found; a newer time replaces an older one, never the reverse. The file is rewritten through a temporary file and a rename under a one-slot claim (`reviewer-state.json.lock.d`), so concurrent loops never lose an update or leave a partial file.

Before anything that would request a review (`not_requested`, `timeout`, or a findings round whose agent would request one), in `cloud` and `auto` mode:

1. If the bot is reviewing the current head (👀) or a request is pending, `run` waits and posts nothing.
2. The newest of the quota reply and the success wins, from this PR's scan and the shared file alike. While the newest event is a quota reply younger than `--quota-window` (16h), the reviewer counts as blocked: `auto` reviews the head locally instead, and every fix agent it spawns (for findings, a gate failure, or a request made while threads were unresolved) reviews locally instead of requesting, and `cloud` stops the PR as `blocked`, naming when the window ends. A completed review or 👍 seen by any loop unblocks every loop for that owner, and each PR that saw the block logs `reviewer_available` once in the run log, with the success's time (`okAt`) and PR (`source`); another owner's quota reply or success never changes it. The window is only a staleness fallback: once the quota reply is older, requests resume normally.
3. A bot reply that cannot review but names no usage, quota or limit (such as "couldn't complete this request") is a reviewer error, not a quota reply. `run` re-requests the review itself (reposting the previous request body, without a fix agent or a round) after each wait of `--reviewer-backoff` (2m, 5m, 10m): one retry per error, so at most three retries, then `auto` reviews locally and `cloud` blocks.

| Option | Environment | Machine file | Default |
|---|---|---|---|
| `--quota-window <dur>` | `PRLOOP_QUOTA_WINDOW` | `quotaWindow` | `16h` |
| `--reviewer-backoff <list>` | `PRLOOP_REVIEWER_BACKOFF` | `reviewerBackoff` | `2m,5m,10m` (its length is the retry count) |

`wait` and `ready` do not consult this memory: `wait` handles any unavailable reply as described above.

Failsafes: one local review per head, a fetched and verified base branch, at most `--max-local-reviews` (3, a nonnegative integer) per PR, and any reviewer failure, malformed output, change to the checkout or posting error ends in `blocked` with the reason instead of a retry.

## Another reviewer bot

| Flag | Environment | Default |
|---|---|---|
| `--reviewer-login <regex>` | `PRLOOP_REVIEWER_LOGIN` | `^chatgpt-codex-connector(\[bot\])?$` |
| `--unavailable-regex <regex>` | `PRLOOP_UNAVAILABLE_REGEX` | usage-limit and failure replies |
| `--trigger <text>` | `PRLOOP_TRIGGER` | `@codex review` |
| `--clean-regex <regex>` | `PRLOOP_CLEAN_REGEX` | `didn.t find any major issues` |
| `--timeout <dur>` | `PRLOOP_TIMEOUT` | `40m` |
| `--ack-timeout <dur>` | `PRLOOP_ACK_TIMEOUT` | `3m` |
| `--interval <dur>` | `PRLOOP_INTERVAL` | `75s` |

Anchor the login regex: any account whose login merely contains the bot's name could otherwise mark a head clean. The bot must react 👀 while working and either react 👍 on the request or post a comment or review matching the clean regex. Review threads it opens count as findings. For example:

```bash
export PRLOOP_REVIEWER_LOGIN='^example-review-bot' PRLOOP_TRIGGER='/review' PRLOOP_CLEAN_REGEX='no issues found'
```

## Limits

- GitHub exposes no push time, so "after the head" uses the latest of the head commit's committer date, the last force-push event, and when prloop first saw this head become the PR head (kept per PR in `heads.json` in the state directory). A signal posted before prloop noticed a head change is ignored, which can cost a re-request but never accepts a review of another head.
- Dismissed bot reviews are ignored, including their inline threads: they are neither clean nor findings signals. A thread with any reply that is not from a bot stays unresolved feedback.
- Reads up to 100 review threads, the latest 100 comments and the latest 50 reviews. More threads fail closed; on a longer history a local review is refused because its limits cannot be verified.
- Transient GitHub errors are retried; three failed polls in a row end `wait` with `error`.
- Outdated threads are flagged `outdated: true` but still count as unresolved: a moved anchor does not prove the finding is fixed.
