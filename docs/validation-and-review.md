# Validation and review

Validation is evidence for a claim. Different claims require different checks.

## Build a validation matrix

Use the [validation-matrix template](../templates/validation-matrix.md) to connect each risk to a command, environment, exact revision, expected result, and retained evidence.

Typical layers are:

1. syntax and formatting;
2. focused unit tests;
3. integration or behavior tests;
4. static analysis and type checking;
5. migrations and compatibility;
6. security and privacy scanning;
7. package or artifact inspection;
8. hosted checks and review;
9. deployment smoke and rollback verification.

Not every task needs every layer. A documentation-only change does not need application execution, but it still needs Markdown structure, link, rendering, privacy, and diff checks.

## Tie evidence to an exact state

Record the branch and full head SHA with every meaningful validation run. If the head changes, decide which checks must repeat. A clean review of an older substantive head cannot approve new behavior.

For generated artifacts, record the source revision and a digest. Verify semantics where possible; byte equality alone can miss a consistently broken build, while a smoke test alone can miss missing files.

## Review all feedback surfaces

Inspect:

- review submissions;
- change requests;
- inline comments;
- conversation resolution state;
- ordinary pull-request comments;
- reactions on the PR body and on review-request comments, including the actor and time;
- automated security findings;
- required and optional checks.

Deduplicate repeated findings. Treat security, privacy, data loss, authorization, and misleading-publication concerns conservatively.

## Codex cloud review signals

Verify the repository's actual cloud-review configuration. Automatic reviews, when enabled, run on a new ready PR without an extra comment. AGENTS.md cannot enable the integration. If no automatic cycle starts, use one `@codex review` request and record the head SHA and request time.

Inspect both the PR body and review-request comment reactions. With the authenticated GitHub API, the read-only routes are:

```text
GET /repos/{owner}/{repo}/issues/{number}/reactions
GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions
GET /repos/{owner}/{repo}/pulls/{number}/reviews
GET /repos/{owner}/{repo}/pulls/{number}/comments
GET /repos/{owner}/{repo}/issues/{number}/comments
```

Paginate complete results. Query GraphQL `reviewThreads` for resolution state and the PR's latest head, checks/statuses, and review decision. An issue-comment list alone does not show thread resolution or all review activity.

Interpret signals conservatively:

| Signal | Meaning and acceptance |
| --- | --- |
| Verified Codex bot eyes reaction | Acknowledged or working; not clean completion |
| Verified Codex bot thumbs-up on PR body or request comment | May be clean completion without a prose review; must belong to the current head/cycle |
| Completed Codex review or clean comment | Inspect its commit identity and all findings; only the current substantive head qualifies |
| Silence, unavailable integration, owner reaction, or stale reaction | Not completed review |

Reactions do not inherently carry a commit SHA. Record the head and request/creation event, verify the actor, and correlate signal timing with that cycle and any linked review/task. A reaction predating a new push cannot clear it. Timestamp alone is insufficient when cycles overlap or the head changed during review; request a fresh head-specific cycle and leave the PR open if attribution cannot be established. Do not equate a clean bot reaction with required human approval or let it override unresolved relevant threads.

After substantive follow-up commits, request a fresh review unless a head-specific automatic cycle is already confirmed running. Repeat until the latest head is clean, not until comments merely stop arriving. Use bounded polling and handoff as described in the [implementation loop](implementation-loop.md); never dismiss a blocking concern or bypass checks to finish a loop.

The official [Codex GitHub review guide](https://learn.chatgpt.com/docs/third-party/github) describes automatic and requested reviews. Integration behavior can change; verify the observed event and actor rather than assuming every repository has the same setup.

## Classify before acting

Use the [review-response template](../templates/review-response.md). A valid but out-of-scope suggestion should be acknowledged and routed, not silently added. An incorrect comment deserves an evidence-based reply. An ambiguous issue stays unresolved while clarification is needed.

Resolve a thread only after the correction is pushed and validated or the response fully establishes why it is non-blocking.

## Report infrastructure truthfully

Distinguish:

- a test that ran and failed;
- a test that passed;
- a job that was skipped;
- a workflow that could not allocate a runner;
- a platform that was not available;
- an external service that was not verified.

Only the first two are test results. The others are limitations or blockers and should remain labelled as such.
