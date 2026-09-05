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
5. Treat eyes as acknowledgement, not completion. A Codex thumbs-up can be clean completion only when attributable to the latest head and cycle; stale/ambiguous reactions and silence do not qualify, and bot review does not replace required human approval.
6. Fix valid in-scope findings narrowly, add normal commits, validate, push, inspect the hosted diff, reply with fixing SHA/evidence, then resolve. Explain incorrect feedback and resolve only when clearly non-blocking. Keep ambiguous or disputed security concerns open; route out-of-scope issues for a decision.
7. Every substantive head needs a fresh completed review. Repeat until no actionable finding, unresolved relevant thread, outstanding change request, failed applicable check, or conflict remains. Use bounded review polling (normally 30–60 seconds, up to about 15 minutes per cycle); hand off the exact pending head if unavailable.
8. Leave the PR for human review unless merging is authorized. Re-query all gates immediately before an authorized GitHub merge, use an expected-head guard, follow the repository merge method, and never use admin bypass. Verify the live target afterward; delete only the merged feature branch when cleanup is authorized. Deployment and rollback have separate checkpoints.

## Instruction maintenance

- Index before adopting new instructions. During authorized implementation, narrowly improve missing or inaccurate guidance in the same PR; do not overwrite stronger rules or edit outside a strict allowlist without approval.
- New projects require a runnable test baseline and real documented commands. Existing projects retain their authoritative gates. Read-only tasks report guidance gaps without modifying files.
- Update this file when layout, commands, invariants, safety or delivery rules change. Keep durable guidance concise and link detailed docs; do not store transient logs, private workstation paths, or secrets here.
- Propose reusable improvements through a normal playbook PR. Do not automatically adopt unreviewed templates or broaden global authority.

## Code Review Rules

Add two or three consequential repository-specific rules, including the safe path or exception. Keep mechanical formatting in CI; do not invent guarantees outside the documented operating boundary.
