# Implementation loop

The implementation loop is small enough to repeat and strict enough to expose uncertainty.

## 1. Discover

For new work, verify the actual upstream target (`main` when that is the project policy; otherwise its default or integration branch), fetch the approved remote, and branch from its current head. Fast-forward only a clean local base; preserve unrelated work through an approved isolated checkout or a handoff. Do not prune user refs or rename branches to force a convention.

For an existing authorized PR, verify the current remote head and continue it with normal follow-up commits. Do not silently restart, rebase, reset, or merge the base. If the upstream target drifts, assess the impact and follow the approved repository update policy or request a decision.

Trace the current behavior from entry point to domain decision, persistence, side effect, and test. Prefer fast repository search and authoritative configuration over assumptions. Note hidden ordering, compatibility, and ownership boundaries.

Do not run historical applications or external integrations simply to understand source that can be inspected statically. If execution is necessary, use synthetic inputs and an isolated environment.

Apply [project onboarding](project-onboarding.md): index the project and initialize or narrowly repair incomplete AGENTS.md during authorized implementation. This does not authorize instruction edits during read-only work or outside an explicit allowlist.

## 2. Design the smallest complete change

“Smallest” means the narrowest change that fully satisfies acceptance, not the fewest edited lines. A one-line patch that leaves documentation contradictory or a caller broken is incomplete.

Identify:

- the source of truth;
- public interfaces that must remain compatible;
- failure behavior;
- migration needs;
- tests that should fail before the fix;
- documentation that would otherwise become inaccurate.

Avoid broad modernization unless it is required to make the scoped change correct.

## 3. Implement normally

Use the repository's existing patterns and tools. Preserve unrelated behavior and legal notices. Keep credentials in supported secret or environment mechanisms, never in examples that resemble real provider values.

For side effects, prefer a pure decision followed by an explicit adapter. Validate authority and configuration before the adapter can act. Use stable idempotency where retries can duplicate business outcomes.

## 4. Validate incrementally

Run syntax and focused tests during implementation. Once the change is coherent, run static analysis, affected integration tests, privacy/security checks, and the documented full gate: before a PR exists, run it directly once per exact clean head, within the machine's load and memory limits; once a PR exists, push first and gate the pushed head (through `prloop ready` when the repository uses [`prloop`](review-wait-loop.md); when it reports `"gate": "deferred"` (a heavy gate or `reviewBeforeGate`), the gate has not run yet: request review only when no automatic cycle is already running, then let `prloop run` gate that head or call `prloop ready` again, before treating the head as validated). Do not use a broad build as the first signal when a focused check can explain the failure more clearly.

## 5. Inspect the result

Read the complete diff as a reviewer. Check deletions, error paths, comments, public copy, generated output, and test assertions. Verify that the diff stays within the approved path set.

After pushing, inspect the hosted diff as well. Local and hosted results can differ because of branch selection, line endings, generated files, or an incorrect remote.

## 6. Review and repeat

With publication authority, push only the feature branch and open a non-draft ready-for-review PR after tests and documentation are ready. Verify the hosted head and diff. A new project's remote and visibility must be agreed first; a local-only task does not authorize publication.

When automatic Codex review is configured, PR creation or the ready transition starts the first cycle. Check the PR-body reactions as well as comments and submissions before sending a duplicate request. If no automatic cycle starts, request `@codex review` once through the supported integration. See [review signal interpretation](validation-and-review.md#codex-cloud-review-signals).

Classify and deduplicate each finding. Record each completed review using the fields in [human and automated review evidence](validation-and-review.md#human-and-automated-review-are-different-evidence). Implement valid in-scope feedback with a normal commit, rerun the relevant focused tests and security checks, push, inspect the hosted diff, reply with the fixing SHA and evidence, resolve the addressed thread, and run the full gate on the pushed head (through `prloop ready` when the repository uses [`prloop`](review-wait-loop.md), which needs the local head to match the PR head and no unresolved thread; handle a `"gate": "deferred"` result as in step 4). Explain invalid feedback with evidence before resolving it; when it comes from misreading the repository's instructions, also correct that wording or add a review-guidelines entry through a normal PR when instruction maintenance is authorized, or report the gap otherwise; leave ambiguous, disputed security, or valid out-of-scope blockers open pending clarification or authority.

Every substantive new head needs a fresh completed review. Repeat as many useful correction cycles as needed, not a fixed two rounds. Convergence means completed clean review of the exact latest head, no unresolved relevant conversation or change request, passing applicable checks, and no merge conflict. Silence and an older thumbs-up do not establish convergence. Do not request redundant reviews merely to accumulate approvals.

Poll at reasonable intervals, normally 30–90 seconds for a bounded time per requested cycle; [`prloop wait`](review-wait-loop.md) does this without spending agent tokens. If a reviewer, check, or integration remains unavailable, leave the PR open with the exact head and blocker. Do not wait indefinitely or spam review requests.

## 7. Human review or authorized merge

Without merge authority, leave the clean PR for human review. When merging is authorized, re-query head/base, review signals, threads, checks, and mergeability immediately beforehand. Use GitHub's supported merge operation with an exact expected-head guard and no administrator bypass. Respect the project's merge policy; use squash when no different policy was approved. Verify the live target branch and expected file/tree changes afterward. Remove only the merged feature branch when cleanup is authorized, and preserve evidence and unrelated refs.

## Plans, trackers and issues

When the task has an active written plan or tracker, keep it current as work progresses: mark finished steps done and add new work and follow-ups. With an explicit issue-write grant (publication authority for a PR does not include it), keep the relevant issues on each affected repository in sync with it: every open follow-up has an issue and a plan row, every deferred finding becomes an issue, work in progress is linked both ways (`Fixes #<n>` in the PR body, the PR link commented on the issue), and after a merge confirm the issue closed and mark the plan row done. Without that grant, record the needed issue changes in the plan or handoff and route them for a decision instead of writing them.

## Task-end cleanup

When the task ends or fails, remove everything temporary it created before handing back: scratch directories, worktrees of merged or closed PRs, test containers and their volumes, and background processes it started. Remove only what the task owns. Keep anything that may be the only copy of diagnostic or rollback evidence or of unpushed work, such as unpushed commits in the worktree of a closed, unmerged PR: preserve it durably first, or leave it in place and name it in the handoff. Prefer a temporary directory that the system clears on reboot for work that does not need to survive one, and mind its size when that directory is memory-backed. Delegated agents (subagents, and their own subagents at any depth) never delete, move or clean up the scratch or session directories of their coordinator or any parent agent, even when those directories sit next to their own temp files or look disposable. Only the agent that created a directory removes it, by its exact path, never by glob or name prefix (other agents' directories may share the prefix); when in doubt, leave it and mention it in the report. A coordinator and its subagents may share one scratch or session directory (no tool setting separates them); its top level belongs to the coordinator, which keeps its own files in `<scratch>/coordinator/`, creates `<scratch>/agents/` before delegating, and names it in each brief. A subagent never creates, edits, overwrites or deletes anything at that top level, in the coordinator's directory or in another agent's directory: at the start of its session it creates its own directory inside `agents/` (`mktemp -d "<scratch>/agents/<task>-XXXXXX"`), keeps every log and temp file there (never fixed names such as `gate.log` elsewhere), and states the path in its report.

## Stopping

Stop when the remaining blocker requires product intent, new authority, unavailable infrastructure, or an external decision. Report the exact boundary so the next run can continue without repeating completed work.
