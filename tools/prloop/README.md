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

## Recommended workflow: one background supervisor

A coordinator (a person or an orchestrating agent) starts one supervisor for a set of PRs and checks in rarely:

```bash
prloop run --repo owner/name --pr 42,43,44 --gate "npm test" --merge squash &   # runs until every PR is done
prloop run --status --repo owner/name                                          # cheap check-in, no GitHub calls
```

`run` polls every PR round-robin every `--interval`, in one process. It syncs a branch that GitHub reports behind or conflicting, waits for the reviewer, runs local reviews when needed, and spawns a fix agent only for findings, a manual conflict, a missing request, a timed-out request or a local-review gate gap. At most `--max-agents` (2) agents or local reviews run at once. It never needs the coordinator between steps and exits only when every PR is `merged`, `merge_pending`, `clean` (without `--merge`), `blocked`, `needs_human`, `needs_agent` (with `--agent none`) or past the `--deadline` (6h). It then prints one JSON line per PR: `verdict`, `reason`, last `head`, `rounds`, and `next`, what a human or the coordinator must do.

Each PR's state lives in `${XDG_STATE_HOME:-~/.local/state}/prloop/<owner>__<name>__<pr>.json`, and every state change is appended to that run's `run-<time>.jsonl` event log in the same directory. `prloop run --status` prints all PR states and the latest events as one JSON object. Rounds and seen findings persist across runs on purpose; delete a PR's state file to reset them.

### Fix agents

Each fix agent runs in the PR's worktree (found with `git worktree list` by branch name, or `--worktree <path>`, which must have the PR branch checked out). Its prompt carries only the current trigger, never the round history: repository, PR, branch, head, worktree, the trigger (`findings`, `conflict`, `not_requested`, `timeout`, `local_review`), its data (compact findings with thread id, path, line and body; the conflicted files; or the previous request body), and the gate command. In one session it must:

1. read only the referenced files plus AGENTS.md;
2. fix each valid finding with a regression test, reply with evidence on invalid ones and leave them unresolved, resolve conflicts;
3. run focused tests while fixing, then commit and push normally (`prloop sync` first if the base moved);
4. resolve the fixed threads and reply on the disputed ones;
5. run `prloop ready`, which runs the gate; after a gate failure, rerun the failing tests or step with their focused command and fix them, including failures it did not cause, before calling `prloop ready` again (at most 5 calls; blocked only when the same failure survives 3 consecutive fixes or the cause is environmental, such as a missing tool, no network or a permission denial);
6. post the review request, reusing the previous request body (skipped with `--reviewer local`);
7. exit with one JSON line: `{"status":"requested|blocked|nothing_to_do","head":"…","fixed":[…],"disputed":[…],"reason":"…"}`.

Fix agents never wait for or poll reviews, merge, touch other PRs, rewrite history except through `prloop sync`, or retry in a loop.

| Option | Default | |
|---|---|---|
| `--gate "<cmd>"` | `PRLOOP_GATE` | The project's full validation command, run by `prloop ready`. Without it the agent runs the gate documented in AGENTS.md or README and calls `prloop mark-tested`. |
| `--agent claude` | yes | `claude -p <prompt> --model claude-opus-5-5 --effort medium --permission-mode auto --output-format json`, run in the worktree so the CLI loads that project's instructions. |
| `--agent codex` | | `codex exec` with a workspace-write sandbox that allows network access. |
| `--agent none` | | Stops the PR at `needs_agent` with the generated `prompt` in its summary, so the coordinator can spawn its own agent and rerun `run`. |
| `--model`, `--effort` | | Override the agent model and effort (`PRLOOP_MODEL`, `PRLOOP_EFFORT`). |
| `--max-agents 2` | 2 | Agents and local reviews running at the same time. |
| `--merge rebase\|squash\|merge` | off | Merges only a head whose fresh snapshot is clean with no unresolved threads, marked tested in the PR worktree with a clean pushed tree, and reported mergeable, using `gh pr merge --match-head-commit <sha>`. A clean but untested head goes to an agent for the gate only. The result is `merged`, or `merge_pending` when a merge queue or auto-merge accepted it without merging yet. |
| `--union <glob>` | | Passed to sync. Reviewer and timing options apply as for `wait`. |

Failsafes end a PR in `blocked` (or `needs_human` for disputed findings) with a reason, never in a loop: maximum rounds per PR (`--max-rounds 8`), an agent that exits non-zero, prints no parseable result line, reports `blocked` or a permission denial, or makes no progress (no new commit, resolved thread, request or tested head), the same finding (path plus normalized first line) returning after two fixes, the overall deadline, and every local-review failsafe.

## Agent-in-the-loop commands

The manual alternative, for an agent that drives one PR itself. Every command prints one JSON object on stdout; `--repo owner/name` defaults to the repository of the current directory.

| Command | Purpose | Exit codes |
|---|---|---|
| `prloop status <pr>` | Head SHA, unresolved threads (id, path, line, first 300 characters), latest trigger comment and whether it is newer than the head commit, reviewer state on the head (`none`, `reviewing`, `clean`, `findings`), and `readyToRequest` with reasons. | 0, 40 |
| `prloop ready <pr>` | Gate before posting a review request, run inside the PR checkout. With `--gate` (or `PRLOOP_GATE`) it first runs the gate on the clean, pushed head and marks it tested; a failure prints the last 60 lines of output. Then it passes only with no unresolved threads, no request already pending on the head, a tested head, and a clean tree on the PR branch whose `HEAD` equals the remote PR head, and lists exactly what is missing. | 0 ready, 50 not ready |
| `prloop mark-tested [--sha <sha>]` | Manual escape hatch for projects without a gate command: records that the gate passed for `HEAD` (or `--sha`). Stored as `prloop-tested` in the Git common directory; never pushed. | 0, 40 |
| `prloop wait <pr>` | Polls every `--interval` (75s) until a verdict. A 👀 reaction means the bot is still reviewing. Posts nothing except a [local review](#local-reviewer-fallback) when one is needed. | see below |
| `prloop sync <pr> [--union <glob>]...` | Brings the PR branch up to date with its base, inside the PR checkout. See [Syncing with the base](#syncing-with-the-base). | 0, 40, 41 |

`wait` verdicts:

| Verdict | Exit | Meaning |
|---|---|---|
| `clean` | 0 | 👍 by the bot on the current request, or (for an automatic review without a request) on the PR body after a 👀 there on this head, or a bot comment or review on the head matching the clean regex. When the bot reacts more than once, the latest reaction wins. |
| `findings` | 10 | Unresolved threads (path, line, up to 2000 characters of body) plus any reviewer summary on this head. |
| `not_requested` | 20 | No trigger comment after the current head commit. Run `prloop ready`, then request a review. |
| `requested_while_unresolved` | 21 | A request was posted while older threads were still open. |
| `timeout` | 30 | No reaction within `--ack-timeout` (3m) of the request, or no result within `--timeout` (40m). Both are measured from the request time, so running `wait` again does not restart the clock. Includes `rerequestBody`, a copy of your last trigger comment, to repost unchanged. A timed-out request no longer blocks `prloop ready`. |
| `unavailable` | 31 | Only with `--reviewer cloud`: the bot replied that it cannot review (usage limit, failure), or two requests on this head timed out. |
| `blocked` | 50 | A local review could not run or post, or its per-head or per-PR limit is used up. |
| `error` | 40 | GitHub could not be read three times in a row, bad input, or history prloop cannot fully see (more than 100 review threads, or more than 100 comments since the head) so it fails closed. |

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

`prloop sync <pr>` runs inside a clean checkout of the PR branch whose `HEAD` equals the remote head. It fetches the base, checks that `origin/<base>` contains the base commit GitHub reports for the PR (so a fork's stale branch is never used), and:

- merges the base when the repository allows merge or squash merges, then pushes normally;
- rebases onto the base when the repository allows only rebase merges, then pushes with `--force-with-lease=<branch>:<expected-sha>`, so it never overwrites commits it has not seen.

Conflicts in files matching `--union` globs (append-only changelogs, CSV ledgers) are resolved as a union of both sides, base lines first, with identical lines kept once. Any other conflict aborts the merge or rebase, leaves the checkout as it was, and exits 41 with `verdict: "conflict"` and the conflicted files, for the agent to resolve by hand. Union resolution suits files where every line is an independent record; do not use it for files whose lines depend on order or on each other.

A successful sync changes the head, so it clears the tested marker: run `prloop ready` (which reruns the gate), then request a review.

## Local reviewer fallback

`--reviewer` (or `PRLOOP_REVIEWER`) selects who reviews:

| Mode | Behavior |
|---|---|
| `cloud` | Only the bot. An unavailable bot ends `wait` with `unavailable` (31). |
| `local` | Never asks the bot. `wait` runs a local review of the current head itself. |
| `auto` (default) | Uses the bot, and runs a local review when the bot replies that it cannot review (default regex matches "reached your ... usage limits", "couldn't complete this request", "unable to review", "quota"; set `--unavailable-regex`) or when two requests on the same head time out. |

The local review is a separate, read-only agent run (`--agent claude` by default with `--permission-mode dontAsk` and only read and `git diff/log/show` tools; `--agent codex` uses `codex exec --sandbox read-only`), never the run that wrote the fix. It needs the same gate as a request: no unresolved threads, a tested head, and `wait` running inside a clean, pushed checkout of the PR branch. It returns structured findings (path, line, severity P0-P3, body), which prloop posts with `gh` under your account (only results posted by the authenticated `gh` user count, so a copied prefix from someone else is ignored) as a normal PR review with inline comments, each prefixed `[local review]`; findings outside the diff go in the review body. A clean result posts `[local review] No issues found on <sha>.` The next poll classifies these exactly like bot results.

Failsafes: one local review per head, a fetched and verified base branch, at most `--max-local-reviews` (3) per PR, and any reviewer failure, malformed output, change to the checkout or posting error ends in `blocked` with the reason instead of a retry.

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
- Reads up to 100 review threads, the latest 100 comments and the latest 50 reviews. More threads fail closed; on a longer history a local review is refused because its limits cannot be verified.
- Transient GitHub errors are retried; three failed polls in a row end `wait` with `error`.
- Outdated threads are flagged `outdated: true` but still count as unresolved: a moved anchor does not prove the finding is fixed.
