# AI-Assisted Engineering Playbook

A practical playbook for AI-assisted software delivery with explicit scope, repository safeguards, testing, security checks, human review, and evidence-backed acceptance.

> **Maintained**
>
> The playbook is designed for reuse. Its examples are fictional, its utilities are read-only by default, and no private repository or workstation context is required.

## What this repository is for

AI coding tools can accelerate discovery, implementation, tests, and documentation. They do not remove the need to decide what should change, protect existing work, validate behavior, or control external side effects.

This repository turns those responsibilities into a concrete workflow:

1. define intent, scope, authority, and acceptance;
2. verify the actual repository and working state;
3. implement the smallest complete change;
4. run proportional tests and security gates;
5. inspect the diff and review feedback;
6. deliver only through an approved external-action boundary;
7. verify the outcome and preserve a truthful handoff.

It is useful for individual contributors, reviewers, and teams writing repository-level agent guidance. It is not tied to one AI vendor or one programming language.

## Start here

- [Intake and scope](docs/intake-and-scope.md)
- [Repository safety](docs/repository-safety.md)
- [Implementation loop](docs/implementation-loop.md)
- [Validation and review](docs/validation-and-review.md)
- [Privacy and secrets](docs/privacy-and-secrets.md)
- [Rollback and handoff](docs/rollback-and-handoff.md)

Use the root [AGENTS.md](AGENTS.md) as a small working example of repository guidance. Copy and adapt [the reusable template](templates/AGENTS.template.md) rather than copying workstation-specific policy from another project.

## Reusable templates

| Template | Use |
|---|---|
| [Task brief](templates/task-brief.md) | Goal, current state, allowed changes, protected inputs, and completion condition |
| [Acceptance criteria](templates/acceptance-criteria.md) | Observable behavior, failure cases, and evidence required |
| [Validation matrix](templates/validation-matrix.md) | Focused, full, security, packaging, and deployment checks |
| [Review response](templates/review-response.md) | Classify feedback and record the fix and validation without overclaiming |
| [Rollback handoff](templates/rollback-handoff.md) | Before state, exact reversal, consequences, and verification |

## Tested utilities

### Repository preflight

```bash
./scripts/repo-preflight.sh /path/to/repository
```

Reports repository root, branch, HEAD, upstream, and whether tracked or untracked changes exist. It performs no mutation and fails closed on a detached head, missing upstream, or dirty state.

### Change-scope check

```bash
python3 scripts/check-change-scope.py \
  --repository /path/to/repository \
  --base origin/main \
  --allowlist approved-paths.txt
```

Compares `BASE...HEAD` plus local changes and untracked files against newline-delimited path or glob rules. A single `*` stays within one path segment; use `**` as its own segment for intentional recursive approval. Renames inspect both source and destination, and index flags that could hide changes fail closed. Repositories or initialized submodules with configured clean/process filters also fail closed rather than executing those filters. The utility reports JSON-quoted path names and exits non-zero when anything is outside the approved scope.

### Report-redaction check

```bash
python3 scripts/check-report-redaction.py \
  --patterns synthetic-patterns.tsv \
  report.txt
```

Checks text reports against named regular expressions. Findings report the rule, file, and line without printing matched content. This is a defense-in-depth check, not a replacement for a maintained secret scanner, privacy review, or human inspection.

All utilities use only Bash, Python's standard library, and Git. Tests create temporary synthetic repositories and never contact the network.

## Fictional delivery example

[The fictional order-service walkthrough](examples/fictional-order-service/README.md) follows one bounded change from task intake through implementation, validation, review, and rollback. Its identifiers and data are synthetic.

Additional stack notes show how the same workflow maps to:

- [PHP and Symfony](examples/php-symfony/README.md)
- [Node.js and TypeScript](examples/node-typescript/README.md)
- [Python](examples/python/README.md)
- [Java and Kotlin](examples/java-kotlin/README.md)

The examples identify representative commands, not universal project conventions. A repository's own documented gate remains authoritative.

## Core principles

- **Intent before implementation:** acceptance criteria shape the solution and its tests.
- **State before mutation:** inspect repository identity, branch, HEAD, remotes, and dirty state first.
- **Authority is explicit:** technical capability is not permission to deploy, merge, delete, contact a provider, or expose data.
- **Existing work is evidence:** do not reset, stash, clean, or overwrite unexplained user changes.
- **Validation is layered:** syntax, focused tests, full gates, security, packaging, and deployment answer different questions.
- **Review follows the head:** substantive follow-up commits require fresh validation and review.
- **Failure is specific:** distinguish product defects, test failures, infrastructure blocks, and unverified external state.
- **Evidence is safe:** retain commands and results without persisting secrets or private data.
- **Rollback has consequences:** restoring an old state may itself be unsafe and can require separate approval.

## Licensing

Documentation, templates, and diagrams are licensed under [CC BY 4.0](LICENSES/CC-BY-4.0.txt). Scripts, tests, fixtures, and synthetic software examples are licensed under [Apache-2.0](LICENSES/Apache-2.0.txt). See [LICENSE.md](LICENSE.md) for the file-level boundary.
