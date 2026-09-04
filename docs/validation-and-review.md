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
- automated security findings;
- required and optional checks.

Deduplicate repeated findings. Treat security, privacy, data loss, authorization, and misleading-publication concerns conservatively.

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
