# Implementation loop

The implementation loop is small enough to repeat and strict enough to expose uncertainty.

## 1. Discover

Trace the current behavior from entry point to domain decision, persistence, side effect, and test. Prefer fast repository search and authoritative configuration over assumptions. Note hidden ordering, compatibility, and ownership boundaries.

Do not run historical applications or external integrations simply to understand source that can be inspected statically. If execution is necessary, use synthetic inputs and an isolated environment.

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

Classify each finding. Implement valid in-scope feedback with a normal commit, rerun the relevant gates, reply with the fix and evidence, resolve the thread, and request fresh review for substantive changes.

Stop when the remaining blocker requires product intent, new authority, unavailable infrastructure, or an external decision. Report the exact boundary so the next run can continue without repeating completed work.
