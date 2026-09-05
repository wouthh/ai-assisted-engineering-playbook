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

Run syntax and focused tests during implementation. Once the change is coherent, run static analysis, affected integration tests, privacy/security checks, and the documented full gate. Do not use a broad build as the first signal when a focused check can explain the failure more clearly.

## 5. Inspect the result

Read the complete diff as a reviewer. Check deletions, error paths, comments, public copy, generated output, and test assertions. Verify that the diff stays within the approved path set.

After pushing, inspect the hosted diff as well. Local and hosted results can differ because of branch selection, line endings, generated files, or an incorrect remote.

## 6. Review and repeat

With publication authority, push only the feature branch and open a non-draft ready-for-review PR after tests and documentation are ready. Verify the hosted head and diff. A new project's remote and visibility must be agreed first; a local-only task does not authorize publication.

When automatic Codex review is configured, PR creation or the ready transition starts the first cycle. Check the PR-body reactions as well as comments and submissions before sending a duplicate request. If no automatic cycle starts, request `@codex review` once through the supported integration. See [review signal interpretation](validation-and-review.md#codex-cloud-review-signals).

Classify and deduplicate each finding. Implement valid in-scope feedback with a normal commit, rerun the relevant focused/full gates and security checks, push, inspect the hosted diff, reply with the fixing SHA and evidence, and resolve the addressed thread. Explain invalid feedback with evidence before resolving it; leave ambiguous, disputed security, or valid out-of-scope blockers open pending clarification or authority.

Every substantive new head needs a fresh completed review. Repeat as many useful correction cycles as needed, not a fixed two rounds. Convergence means completed clean review of the exact latest head, no unresolved relevant conversation or change request, passing applicable checks, and no merge conflict. Silence and an older thumbs-up do not establish convergence. Do not request redundant reviews merely to accumulate approvals.

Poll at reasonable intervals, normally 30–60 seconds for up to about 15 minutes per requested cycle. If a reviewer, check, or integration remains unavailable, leave the PR open with the exact head and blocker. Do not wait indefinitely or spam review requests.

## 7. Human review or authorized merge

Without merge authority, leave the clean PR for human review. When merging is authorized, re-query head/base, review signals, threads, checks, and mergeability immediately beforehand. Use GitHub's supported merge operation with an exact expected-head guard and no administrator bypass. Respect the project's merge policy; use squash when no different policy was approved. Verify the live target branch and expected file/tree changes afterward. Remove only the merged feature branch when cleanup is authorized, and preserve evidence and unrelated refs.

Stop when the remaining blocker requires product intent, new authority, unavailable infrastructure, or an external decision. Report the exact boundary so the next run can continue without repeating completed work.
