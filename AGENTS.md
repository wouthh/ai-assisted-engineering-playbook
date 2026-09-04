# Repository guidance

This repository is a reusable playbook for human-owned AI-assisted software delivery.

## Invariants

- Human intent, authority, review, and acceptance remain explicit.
- Utilities are read-only by default, offline-capable, and tested with synthetic fixtures.
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
bash -n scripts/repo-preflight.sh
python3 -m py_compile scripts/check-change-scope.py scripts/check-report-redaction.py
python3 scripts/check-change-scope.py --help
python3 scripts/check-report-redaction.py --help
git diff --check
```

Inspect the complete staged diff before committing. Do not add generated reports, local repositories, tokens, or execution logs.
