# Fictional order-service walkthrough

This synthetic example shows how the playbook handles a bounded rule change without needing a real service, provider, or dataset.

## Requested change

Orders above a configurable review threshold must return `manual_review` instead of `approved`. Invalid identifiers and non-positive amounts must continue to fail closed. No HTTP, persistence, or deployment change is in scope.

The example is intentionally small. The point is the delivery contract around the code, not the complexity of the function.

## 1. Intake

Goal: add an explicit manual-review outcome to the pure decision function.

Allowed paths:

```text
examples/fictional-order-service/src/order_rules.py
examples/fictional-order-service/tests/test_order_rules.py
examples/fictional-order-service/README.md
```

Acceptance:

- valid orders at or below the threshold are approved;
- valid orders above the threshold require manual review;
- missing identifiers and non-positive amounts are rejected;
- the threshold itself is validated;
- no network or persistence is introduced.

## 2. Preflight

In a real repository, run the repository preflight before editing and record the branch and head. Use trusted tools, stop other repository writers, and keep configuration stable during inspection. The helpers detect observed drift; they are not a sandbox or atomic isolation boundary. This example is part of the playbook repository, so its changes are covered by the root validation gate and change-scope review.

For a new implementation branch, refresh the verified upstream target and branch from it. Index the real project before adapting missing AGENTS.md guidance; an existing authorized PR instead continues from its verified remote head. Do not replace unrelated work or infer a publication destination.

## 3. Implementation

[`src/order_rules.py`](src/order_rules.py) keeps the decision pure. Input validation occurs before the amount comparison, and the result is an explicit enum rather than an ambiguous Boolean.

The threshold is an argument. Production configuration would resolve and validate it at an application boundary before calling the domain function.

## 4. Validation

Run:

```bash
python3 -m unittest discover -s examples/fictional-order-service/tests -v
python3 -m py_compile examples/fictional-order-service/src/order_rules.py
git diff --check
git diff --cached --check
```

Tests cover the values immediately below, at, and above the threshold plus invalid input. They use no real data.

## 5. Review

A useful review asks whether the boundary is correct, whether equality is specified, and whether invalid configuration fails closed. A request to add a database, framework, or deployment would be valid future work but outside this task.

If a correction changes behavior, add a normal follow-up commit, rerun the focused and full gates, and obtain a fresh review of the new head.

After validation and authorized publication, open a ready PR. Check the automatic Codex review first, including reactions on the PR body. A current-cycle bot thumbs-up may be its clean result without a comment, but eyes, silence, and stale reactions are not completion. Inspect every feedback surface, reply and resolve only addressed findings, and repeat on substantive heads until clean. An unavailable review produces an exact-head handoff, not a claim of success. These are illustrative steps; no actual cloud review was run for this fictional service.

## 6. Delivery and rollback

This example has no deployment. In a real repository, leave the PR for human review unless merging is authorized. Then merge through GitHub only after the exact validated head has a clean review and all other gates pass; re-query before merging and verify the live target afterward.

Rollback would use a normal revert pull request. If real orders had already been routed for review, operational reconciliation would be required before reverting behavior; the Git revert alone would not undo those decisions.

## Evidence and limitations

The example proves a pure decision and its tests. It does not claim to demonstrate authentication, persistence, idempotent message delivery, or production rollout. Those would require their own acceptance criteria and fixtures.
