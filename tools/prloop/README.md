# prloop

`prloop` waits for an external pull-request reviewer bot so a coding agent does not have to. It polls GitHub quietly, then prints one compact JSON verdict and exits with a code the agent can branch on. The agent still does the work: fixing code, running tests, replying to and resolving threads, and posting the review request.

The default reviewer is the Codex GitHub connector (login matching `/codex/i`, triggered by a `@codex review` comment). Any bot with a similar request-and-react pattern can be configured.

The tool is one Node.js ES module with no dependencies. It needs Node 20+, Git and an authenticated [GitHub CLI](https://cli.github.com/) (`gh`).

## Install

```bash
ln -sf "$PWD/bin/prloop" ~/.local/bin/prloop   # run from the repository root
prloop --help
```

`bin/prloop` is a symlink to `tools/prloop/prloop.mjs`. Run the tests with `node --test` from the repository root; they use fixture JSON and temporary Git repositories and never contact the network.

## Commands

Every command prints one JSON object on stdout. `--repo owner/name` defaults to the repository of the current directory.

| Command | Purpose | Exit codes |
|---|---|---|
| `prloop status <pr>` | Head SHA, unresolved threads (id, path, line, first 300 characters), latest trigger comment and whether it is newer than the head commit, reviewer state on the head (`none`, `reviewing`, `clean`, `findings`), and `readyToRequest` with reasons. | 0, 40 |
| `prloop ready <pr>` | Gate before posting a review request. Passes only with no unresolved threads, no request already pending on the head, a tested head and, inside a checkout of the PR branch, a clean tree whose `HEAD` equals the remote PR head. Lists exactly what is missing. | 0 ready, 50 not ready |
| `prloop mark-tested [--sha <sha>]` | Records that your gate passed for `HEAD` (or `--sha`). Stored as `prloop-tested` in the Git common directory; never pushed. | 0, 40 |
| `prloop wait <pr>` | Polls every `--interval` (75s) until a verdict. A 👀 reaction means the bot is still reviewing. Never posts anything. | see below |
| `prloop sync <pr> [--union <glob>]...` | Brings the PR branch up to date with its base, inside the PR checkout. See [Syncing with the base](#syncing-with-the-base). | 0, 40, 41 |
| `prloop run --repo o/n --pr N[,N...]` | Optional supervisor that waits, spawns one fresh agent per round and stops on failsafes. See [Supervisor](#supervisor). | 50 if any PR is blocked, else the first verdict code that needs action, else 0 |

`wait` verdicts:

| Verdict | Exit | Meaning |
|---|---|---|
| `clean` | 0 | 👍 by the bot on the current request or on the PR body, or a bot comment or review on the head matching the clean regex. When the bot reacts more than once, the latest reaction wins. |
| `findings` | 10 | Unresolved threads (path, line, up to 2000 characters of body) plus any reviewer summary on this head. |
| `not_requested` | 20 | No trigger comment after the current head commit. Run `prloop ready`, then request a review. |
| `requested_while_unresolved` | 21 | A request was posted while older threads were still open. |
| `timeout` | 30 | No reaction within `--ack-timeout` (3m) of the request, or no result within `--timeout` (40m). Both are measured from the request time, so running `wait` again does not restart the clock. Includes `rerequestBody`, a copy of your last trigger comment, to repost unchanged. A timed-out request no longer blocks `prloop ready`. |
| `unavailable` | 31 | Only with `--reviewer cloud`: the bot replied that it cannot review (usage limit, failure), or two requests on this head timed out. |
| `blocked` | 50 | A local review could not run or post, or its per-head or per-PR limit is used up. |
| `error` | 40 | GitHub could not be read three times in a row, bad input, or more than 100 review threads (prloop fails closed rather than miss one). |

## Agent workflow

```bash
npm test                          # or whatever the project's gate is
git push
prloop mark-tested
prloop ready 42 && gh pr comment 42 --body "@codex review"
prloop wait 42                    # one call instead of dozens of polls
case $? in
  0)  echo "clean on the current head" ;;
  10) echo "fix findings, reply and resolve threads, then start again" ;;
  20) echo "request a review" ;;
  30) echo "repost rerequestBody" ;;
esac
```

## Syncing with the base

`prloop sync <pr>` runs inside a clean checkout of the PR branch whose `HEAD` equals the remote head. It fetches the base and:

- merges the base when the repository allows merge or squash merges, then pushes normally;
- rebases onto the base when the repository allows only rebase merges, then pushes with `--force-with-lease=<branch>:<expected-sha>`, so it never overwrites commits it has not seen.

Conflicts in files matching `--union` globs (append-only changelogs, CSV ledgers) are resolved as a union of both sides, base lines first, with identical lines kept once. Any other conflict aborts the merge or rebase, leaves the checkout as it was, and exits 41 with `verdict: "conflict"` and the conflicted files, for the agent to resolve by hand. Union resolution suits files where every line is an independent record; do not use it for files whose lines depend on order or on each other.

A successful sync changes the head, so it clears the tested marker: run your gate, `prloop mark-tested`, then request a review.

## Supervisor

```bash
prloop run --repo owner/name --pr 42,43 --agent claude --max-rounds 8 --merge rebase
```

For each PR, sequentially: sync if GitHub reports the branch behind or conflicting, wait, and on `findings`, `timeout`, `not_requested`, `requested_while_unresolved` or a manual `conflict` spawn one fresh agent in the PR's worktree (found with `git worktree list` by branch name, or `--worktree <path>`). The prompt contains the PR number, the verdict, compact findings and the rules: fix, test, `prloop mark-tested`, reply and resolve, `prloop ready`, then post the request.

| Option | Default | |
|---|---|---|
| `--agent claude` | yes | `claude -p <prompt> --model claude-opus-5-5 --effort medium --permission-mode auto --output-format json`, run in the worktree so the CLI loads that project's instructions. |
| `--agent codex` | | `codex exec` with a workspace-write sandbox that allows network access. |
| `--agent none` | | Prints the verdict with the generated `prompt` and exits with the verdict code, so a coordinator can spawn its own agent. |
| `--model`, `--effort` | | Override the agent model and effort (`PRLOOP_MODEL`, `PRLOOP_EFFORT`). |
| `--merge rebase\|squash\|merge` | off | Merges only when the current head is clean, marked tested in the PR worktree with a clean pushed tree, and GitHub reports it mergeable, with `gh pr merge --match-head-commit <sha>`. A clean but untested head returns `not_tested` (22) and goes to the agent for the gate. The result is `merged` with the merge commit, or `merge_pending` when a merge queue or auto-merge accepted it without merging yet. |
| `--deadline 4h` | 4h | Overall deadline for the whole run. |
| `--union` | | Passed to sync. Reviewer and timing options apply as for `wait`. |

A single wait is bounded by `--timeout`, so the overall deadline is checked between rounds. Every failsafe ends in `verdict: "blocked"` with a reason (exit 50) instead of looping: maximum rounds per PR, the agent exiting non-zero, the agent pushing no commit, resolving no thread and posting no request, the same finding (path plus normalized first line) returning after two fixes, the overall deadline, or agent output reporting a permission denial.

State (rounds, seen findings, last verdict) lives in `${XDG_STATE_HOME:-~/.local/state}/prloop/<owner>__<name>__<pr>.json`. Rounds persist across runs on purpose; delete the file to reset the budget for a PR.

## Local reviewer fallback

`--reviewer` (or `PRLOOP_REVIEWER`) selects who reviews:

| Mode | Behavior |
|---|---|
| `cloud` | Only the bot. An unavailable bot ends `wait` with `unavailable` (31). |
| `local` | Never asks the bot. `wait` runs a local review of the current head itself. |
| `auto` (default) | Uses the bot, and runs a local review when the bot replies that it cannot review (default regex matches "reached your ... usage limits", "couldn't complete this request", "unable to review", "quota"; set `--unavailable-regex`) or when two requests on the same head time out. |

The local review is a separate, read-only agent run (`--agent claude` by default with `--permission-mode dontAsk` and only read and `git diff/log/show` tools; `--agent codex` uses `codex exec --sandbox read-only`), never the run that wrote the fix. It needs the same gate as a request: no unresolved threads, a tested head, and `wait` running inside a clean, pushed checkout of the PR branch. It returns structured findings (path, line, severity P0-P3, body), which prloop posts with `gh` under your account as a normal PR review with inline comments, each prefixed `[local review]`; findings outside the diff go in the review body. A clean result posts `[local review] No issues found on <sha>.` The next poll classifies these exactly like bot results.

Failsafes: one local review per head, at most `--max-local-reviews` (3) per PR, and any reviewer failure, malformed output, change to the checkout or posting error ends in `blocked` with the reason instead of a retry.

## Another reviewer bot

| Flag | Environment | Default |
|---|---|---|
| `--reviewer-login <regex>` | `PRLOOP_REVIEWER_LOGIN` | `codex` |
| `--trigger <text>` | `PRLOOP_TRIGGER` | `@codex review` |
| `--clean-regex <regex>` | `PRLOOP_CLEAN_REGEX` | `didn.t find any major issues` |
| `--timeout <dur>` | `PRLOOP_TIMEOUT` | `40m` |
| `--ack-timeout <dur>` | `PRLOOP_ACK_TIMEOUT` | `3m` |
| `--interval <dur>` | `PRLOOP_INTERVAL` | `75s` |

The bot must react 👀 while working and either react 👍 on the request or post a comment or review matching the clean regex. Review threads it opens count as findings. For example:

```bash
export PRLOOP_REVIEWER_LOGIN='^example-review-bot' PRLOOP_TRIGGER='/review' PRLOOP_CLEAN_REGEX='no issues found'
```

## Limits

- "After the head" uses the later of the head commit's committer date and the last force-push event; GitHub exposes no push time. A fast-forward to a commit dated before an existing request is not detected, which `ready` avoids by requiring a pushed head before each request.
- Reads the latest 100 review threads and comments and 50 reviews; very long PRs may need a fresh PR.
- Transient GitHub errors are retried; three failed polls in a row end `wait` with `error`.
- Outdated threads are flagged `outdated: true` but still count as unresolved: a moved anchor does not prove the finding is fixed.
