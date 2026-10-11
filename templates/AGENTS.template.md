# Repository guidance

Adapt this template after indexing the project. Replace explanatory placeholders with verified repository facts; preserve existing stronger guidance and applicable overrides. Policy: `implementation-review-loop-v1`.

## Purpose

Describe what this repository owns and the audience it serves.

## Repository map and instruction precedence

- Identify the actual Git root, default/integration branch, entry points, domain modules, persistence, tests, generated files, and canonical docs.
- List applicable nested instruction/override files and explain which areas they govern. Keep the map short and evidence-backed.

## Protected state

- List files, data, environments, and external systems that require special care.
- State how to handle an existing dirty working tree.
- State which values must never appear in logs, commits, or review comments.
- When using the playbook's inspection helpers, require trusted tools, a quiescent checkout, and stable configuration. Observed-drift checks are not a sandbox or atomic isolation; stop if these prerequisites cannot be established.

## Change boundaries

- Identify allowed areas for ordinary work.
- Identify changes that require a separate plan or explicit approval.
- Separate implementation from merge, deployment, provider access, and destructive recovery.

## Architecture and invariants

- Name the authoritative domain and persistence boundaries.
- Record ordering, compatibility, idempotency, and failure-closed requirements.
- Link to canonical documentation instead of duplicating it.

## Validation

```text
Focused check: <command>
Full local gate: <command>
Security or privacy gate: <command>
Packaging or build gate: <command or not applicable>
```

State what each command proves and which environment is authoritative.

## Delivery

1. For new work, verify and refresh the approved upstream target, then create a feature branch from it. Normally this is main; use the project's actual default/integration branch. Preserve dirty user work. Resume an authorized existing PR at its exact remote head with normal commits, without silent rebase/reset.
2. Implement the scoped feature, add regression tests, and update relevant docs and this file when contracts or commands change. Run focused checks and the full applicable gate above, including static/security checks. Record unavailable infrastructure honestly; do not claim skipped checks passed.
3. With publication authority, push only the feature branch, create a ready non-draft PR, and verify the hosted head and complete diff. A local-only task or unapproved new remote does not permit publication.
4. Verify whether Codex automatic review starts on PR creation. Inspect the PR-body reactions and review-request reactions as well as reviews, inline threads, ordinary comments, resolution states, checks and change requests. Do not duplicate a running automatic cycle; request `@codex review` if needed.
5. Treat eyes as acknowledgement, not completion. A Codex thumbs-up can be clean completion only when attributable to the latest head and cycle; stale/ambiguous reactions and silence do not qualify, and bot review does not replace required human approval. Record reviewer or tool identity, automated or human review type, exact head, scope and coverage, outcome, and remaining findings. A clean automated review is evidence of that recorded automated outcome only; record any actual human inspection or acceptance separately.
6. Fix valid in-scope findings narrowly, add normal commits, validate, push, inspect the hosted diff, reply with fixing SHA/evidence, then resolve. Explain incorrect feedback and resolve only when clearly non-blocking. Keep ambiguous or disputed security concerns open; route out-of-scope issues for a decision.
7. Every substantive head needs a fresh completed review. Repeat until no actionable finding, unresolved relevant thread, outstanding change request, failed applicable check, or conflict remains. Use bounded review polling, preferably through the PR review loop below; hand off the exact pending head if unavailable.
8. Leave the PR for human review unless merging is authorized. Re-query all gates immediately before an authorized GitHub merge, use an expected-head guard, follow the repository merge method, and never use admin bypass. Verify the live target afterward; delete only the merged feature branch when cleanup is authorized. Deployment and rollback have separate checkpoints.

## PR review loop

Install [`prloop`](https://github.com/wouthh/ai-assisted-engineering-playbook/tree/main/tools/prloop) on `PATH` (a symlink to `bin/prloop` is enough). It waits for the review bot and prints one JSON verdict; it never posts or fixes anything. Remove this section if the project does not use an automated reviewer.

1. Implement the change, run the full local gate above, commit and push.
2. `prloop mark-tested` once the gate passes on the pushed head.
3. Reply to and resolve every addressed review thread.
4. `prloop ready <pr>`; if it fails, fix exactly what it lists.
5. Post the review request once (default `@codex review`; configure other bots with `PRLOOP_REVIEWER_LOGIN`, `PRLOOP_TRIGGER` and `PRLOOP_CLEAN_REGEX`).
6. `prloop wait <pr>`, then act on the verdict: `clean` (0) stop or hand over for merge; `findings` (10) fix and restart at step 1; `not_requested` (20) restart at step 4; `requested_while_unresolved` (21) resolve threads, then step 4; `timeout` (30) run `prloop ready`, then repost `rerequestBody` unchanged; `error` (40) report.
7. If GitHub reports the branch behind or conflicting, run `prloop sync <pr>` in the PR checkout and restart at step 1; on `conflict` (41) resolve the listed files by hand.

Failsafes: stop and report on `blocked` (50) or `error`, after the project's round limit (default 8), or when the same finding returns after two fixes. Never poll GitHub manually, never post a second request while one is running on the same head, and never loop without new commits, replies or resolved threads.

## Instruction maintenance

- Index before adopting new instructions. During authorized implementation, narrowly improve missing or inaccurate guidance in the same PR; do not overwrite stronger rules or edit outside a strict allowlist without approval.
- New projects require a runnable test baseline and real documented commands; do not assume an existing remote, base branch, or commit history. Creating or publishing a repository requires task authorization. Existing projects retain their authoritative gates. Read-only tasks report guidance gaps without modifying files.
- Update this file when layout, commands, invariants, safety or delivery rules change. Keep durable guidance concise and link detailed docs; do not store transient logs, private workstation paths, or secrets here.
- Make onboarding idempotent: preserve custom and nested instructions, add only missing or inaccurate guidance, and leave files unchanged on a second pass without new facts.
- Propose a normal playbook PR only for a material reusable gap when cross-repository maintenance is authorized. Project-specific updates alone do not require one. Never propagate proprietary rules or private data, automatically adopt unreviewed templates, or broaden global authority.

## Code Review Rules

Add two or three consequential repository-specific rules, including the safe path or exception. Keep mechanical formatting in CI; do not invent guarantees outside the documented operating boundary.
