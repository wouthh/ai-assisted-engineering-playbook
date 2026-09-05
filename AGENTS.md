# Repository guidance

This repository is a reusable playbook for human-owned AI-assisted software delivery.

## Invariants

- Human intent, authority, review, and acceptance remain explicit.
- Utilities are read-only by default, offline-capable, and tested with synthetic fixtures. Repository inspection requires trusted tools, a quiescent checkout, and stable configuration; observed-drift checks are not sandboxing or atomic isolation.
- Never add workstation-specific paths, credentials, personal data, private repository references, or real provider payloads.
- Examples must be fictional or independently reusable. Do not copy source from another repository.
- Do not present the redaction helper as a complete secret scanner.
- Keep external writes, destructive actions, deployment, merging, and credential validation behind separate approval checkpoints.
- A passing command is evidence only for the exact repository state and head that produced it.
- Update documentation, templates, utilities, tests, and the fictional walkthrough together when their contract changes.

## Validation

Run from the repository root:

```bash
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s examples/fictional-order-service/tests -v
bash -n scripts/repo-preflight.sh
./scripts/repo-preflight.sh --help
python3 -m py_compile scripts/check-change-scope.py scripts/check-report-redaction.py examples/fictional-order-service/src/order_rules.py
python3 scripts/check-change-scope.py --help
python3 scripts/check-report-redaction.py --help
git diff --check
git diff --cached --check
```

Inspect the complete staged diff before committing. Do not add generated reports, local repositories, tokens, or execution logs.

## Default delivery and guidance maintenance

Policy: `implementation-review-loop-v1`. Follow [project onboarding](docs/project-onboarding.md), the [implementation loop](docs/implementation-loop.md), and [validation and review](docs/validation-and-review.md).

- Index before editing. New work starts from refreshed upstream `main` on a feature branch; an authorized existing PR continues from its exact remote head without silent rebase or reset.
- Keep this file, the reusable AGENTS template, linked workflow documentation, and fictional walkthrough consistent when their contract changes. Preserve scoped, repository-specific review rules rather than copying every general rule into each file.
- Cross-repository playbook maintenance requires a material reusable gap and authorization for that work. Project-specific guidance changes alone do not require a playbook PR; never propagate private project details.
- For authorized publication, validate and document the change, push normal commits, open a ready PR, and verify the hosted diff. First inspect the configured automatic review, including Codex reactions on the PR body; request review only if no current cycle is running.
- Evaluate all feedback, fix valid in-scope findings, validate/push, reply and resolve addressed threads, then obtain fresh completed review of the substantive head. A bot thumbs-up must be attributable to that head; eyes, stale reactions, and silence are not clean review.
- Incorrect findings need evidence before resolution; ambiguous or disputed security findings remain open. Use bounded waits and an exact-head handoff when review is unavailable.
- Leave clean PRs for human review unless GitHub merging is explicitly authorized. Never self-approve or bypass repository requirements.

## Code Review Rules

- Flag actual side effects, secret disclosure, or false success within the helpers' documented trusted-tool, quiescent-checkout boundary. They do not promise sandboxing or atomic isolation against concurrent writers; any broader requirement needs an explicit design decision, not a claim of protection from repeated checks alone.
- Scope checks must include committed, staged, unstaged, untracked, renamed/deleted, and nested submodule paths, or fail closed when they cannot be inspected. A gitlink allowlist entry alone does not approve every nested file.
- Review-completion guidance must distinguish a current-head clean bot signal from acknowledgement, silence, stale reactions, and human approval. Mechanical formatting checks belong in validation, not stylistic review churn.
