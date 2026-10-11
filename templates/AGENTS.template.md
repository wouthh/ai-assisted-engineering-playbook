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

Install [`prloop`](https://github.com/wouthh/ai-assisted-engineering-playbook/tree/main/tools/prloop) on `PATH` (a symlink to `bin/prloop` is enough). A plain script does the polling, gating and syncing, so model tokens go only to real work. Remove this section if the project does not use an automated reviewer.

### Coordinator

- Group ready PRs into one batch and start the supervisor once, in the background: `prloop run --repo <owner/name> --pr <N,...> --gate "<full local gate>" --max-agents 2 &`.
- Check `prloop run --status --repo <owner/name>` only on a notification or every 20-30 minutes or more, never in a tight loop.
- Act only on the final summary or on `blocked`, `needs_human` and `needs_agent` items. Never poll GitHub or wait for reviews yourself.
- At the round cap (`max rounds (6) reached`), judge each remaining finding by its real impact, not the reviewer's severity label, and check the edge cases yourself. Low-risk leftovers: merge when authorized, reply on each thread that it is deferred, and record a follow-up. Important defects: run `prloop reset-rounds <pr>` once for another full cap; if they still remain, hand over to a human.
- Do not request a review only because a branch was synced: `prloop` carries a clean review across a sync that leaves the PR's own change identical (the synced head still needs the gate before a merge).
- Cap parallel load with `--max-agents`, and keep this file and shared templates current when the workflow changes.

### Fix agent (one session, one step)

1. Read only the referenced files plus this file.
2. Fix each valid finding with a regression test; reply with evidence on invalid ones and leave them unresolved, except a finding proven to misread this file, which you resolve after the evidence reply (see Instruction maintenance); resolve conflicts.
3. Run focused tests, then commit and push normally (`prloop sync <pr>` first if the base moved).
4. Resolve the fixed threads; reply on disputed ones.
5. `prloop ready <pr>` runs the gate and marks the head tested. After a gate failure, rerun the failing tests or step with their focused command and fix them, including failures you did not cause, before calling `prloop ready` again. At most 5 calls; stop as blocked only when the same failure survives 3 consecutive fixes or the cause is environmental (missing tool, no network, permission denied).
6. Post the review request once, reusing the previous request body.
7. Exit with one JSON line: `{"status":"requested|blocked|nothing_to_do","head":"…","fixed":[…],"disputed":[…],"reason":"…"}`.

Never wait for or poll reviews, merge, touch other PRs, rewrite history except through `prloop sync`, or retry in a loop. A permission denial or missing tool means stop as blocked.

### Manual mode (one agent, no supervisor)

Run the fix-agent steps, then `prloop wait <pr>` and act on its verdict: `clean` (0) stop; `findings` (10) start again at step 1; `not_requested` (20) step 5; `requested_while_unresolved` (21) step 4; `timeout` (30) repost `rerequestBody` after `prloop ready`; `unavailable` (31) report or use `--reviewer local`; `blocked` (50) or `error` (40) stop and report. Use `prloop status <pr>` for a one-off look.

## Instruction maintenance

- Index before adopting new instructions. During authorized implementation, narrowly improve missing or inaccurate guidance in the same PR; do not overwrite stronger rules or edit outside a strict allowlist without approval.
- New projects require a runnable test baseline and real documented commands; do not assume an existing remote, base branch, or commit history. Creating or publishing a repository requires task authorization. Existing projects retain their authoritative gates. Read-only tasks report guidance gaps without modifying files.
- Update this file when layout, commands, invariants, safety or delivery rules change. Keep durable guidance concise and link detailed docs; do not store transient logs, private workstation paths, or secrets here.
- When a reviewer finding comes from misreading this file (for example a wrong-identity claim based on commits the review sandbox created itself, while the hosting record of the exact PR commit is correct), verify it against the hosting record, reply with that evidence, resolve the thread, and correct the misleading wording or add a review-guidelines entry in a normal PR when instruction maintenance and publication are already authorized; otherwise report the gap or request a scope extension.
- Make onboarding idempotent: preserve custom and nested instructions, add only missing or inaccurate guidance, and leave files unchanged on a second pass without new facts.
- Propose a normal playbook PR only for a material reusable gap when cross-repository maintenance is authorized. Project-specific updates alone do not require one. Never propagate proprietary rules or private data, automatically adopt unreviewed templates, or broaden global authority.

## Code Review Rules

Add two or three consequential repository-specific rules, including the safe path or exception. Judge commit identity only from the hosting record of the exact PR commit, never from commits created inside the review environment. Keep mechanical formatting in CI; do not invent guarantees outside the documented operating boundary.
