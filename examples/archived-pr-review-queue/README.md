# Archived example: PR review follow-up queue core

> **Archived and not maintained.**
>
> This is a sanitized snapshot of the pure core of a retired automation. It is
> published for reading, not for reuse as-is. It has no tests here, no
> compatibility promise, and it is not covered by this repository's validation.

## What it was

A private project ran a human-launched queue that worked through open pull
requests with an automated reviewer. For each pull request it gathered the
current review findings, clustered them by root cause, let a local coding
worker repair the accepted clusters, ran the project's full gate, pushed,
resolved fully addressed threads, and requested at most one new review. The
orchestrator (a large shell and Node script) was tightly coupled to that
project and has been retired there.

Only the side-effect-free policy modules and the worker process boundary are
kept. The orchestrator, project-specific prompts, GitHub writes, and tests are
not included.

## Files

| File | Responsibility |
|---|---|
| `review-policy.mjs` | Review budget per pull request: one initial full review plus two targeted closure reviews per epoch, keyed by immutable repository and pull-request node IDs. Request-cycle markers, idempotent request comments, out-of-band trigger accounting, and state-schema migration that never treats malformed state as empty. |
| `review-generation.mjs` | One review generation: assign each current finding to exactly one root-cause cluster, cap raw threads and clusters, build a bounded context pack, route clusters to a normal or critical worker profile by risk domain, and validate the completion attestation (exact tree, focused tests, `git diff --check`, full gate). |
| `review-state.mjs` | Reviewer configuration and clean-signal detection. Distinguishes an explicit current-head "no findings" result from silence, acknowledgement reactions, timeouts, and stale reviews. |
| `worker-boundary.py`, `worker-supervisor.mjs` | Linux-only process containment: a child-subreaper boundary and a supervisor that terminates every descendant of a worker on exit or timeout. |

## Ideas worth keeping

- A review cycle is clean only after an explicit current-head no-findings
  signal with no new unresolved threads. Silence, eyes reactions, timeouts,
  stale approvals, and an earlier head's clean result are not clean.
- Resolve a thread only after the current implementation and validation show
  its finding is fixed or concretely invalid. An outdated anchor alone is not
  evidence.
- Spend review budget only on a confirmed trigger, and key it to identities
  that renames, rebases, and force-pushes cannot reset.
- Fail closed on ambiguous or corrupt state instead of starting over.

These rules are covered in maintained form by
[validation and review](../../docs/validation-and-review.md).

## Before adapting any of it

The original automation pushed commits, posted comments, resolved threads, and
could merge. Any adaptation must keep those external writes behind explicit
approval checkpoints, as described in [repository safety](../../docs/repository-safety.md).
Reviewer names and model profile names in the code are configuration examples
from the original setup.
