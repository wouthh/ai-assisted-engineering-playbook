# AI-Assisted Engineering Playbook

## Why this exists

Coding agents working on real repositories write code fast, but they also overwrite unexplained work, claim tests passed on a different head, commit under the wrong identity, and wait on review by polling.
I built this playbook to keep a human in charge of scope, validation and merging while the agent does the engineering.
It gives you written rules an agent can follow, small read-only checks that enforce them, and a review loop that spends model tokens only when there is work.

Every task follows the same workflow:

1. define intent, scope, authority, and acceptance;
2. verify the actual repository and working state;
3. implement the smallest complete change;
4. run proportional tests and security gates;
5. inspect the diff and review feedback;
6. deliver only through an approved external-action boundary;
7. verify the outcome and preserve a truthful handoff.

It is not tied to one AI vendor or programming language. Its examples are fictional, its utilities are read-only by default, and it needs no private repository or workstation context.

## Start here

- [Intake and scope](docs/intake-and-scope.md)
- [Repository safety](docs/repository-safety.md)
- [Project onboarding and instruction maintenance](docs/project-onboarding.md)
- [Implementation loop](docs/implementation-loop.md)
- [Validation and review](docs/validation-and-review.md)
- [Review wait loop](docs/review-wait-loop.md)
- [Privacy and secrets](docs/privacy-and-secrets.md)
- [Git identity guard](docs/git-identity-guard.md)
- [Rollback and handoff](docs/rollback-and-handoff.md)

Use the root [AGENTS.md](AGENTS.md) as a small working example of repository guidance. Copy and adapt [the reusable template](templates/AGENTS.template.md) rather than copying workstation-specific policy from another project.

The recommended delivery path is a refreshed upstream base, a feature branch, tests and documentation, a ready PR, review of the current head, and human acceptance or an explicitly authorized GitHub merge. The [review evidence guidance](docs/validation-and-review.md#human-and-automated-review-are-different-evidence) defines what a completed review record must capture. This guidance does not establish that every past change followed the path. Instruction maintenance is part of authorized implementation, not permission to edit projects during a read-only task. Cloud review must actually be configured; AGENTS.md alone does not enable it.

## A typical run

A fictional example: a team asks an agent to add a discount rule to `acme/order-service`.

1. The task brief (from [the template](templates/task-brief.md)) names the goal ("orders over 100 units get 5% off"), the allowed paths (`src/pricing/`, `tests/pricing/`), and what stays out of scope (deployment, merging).
2. The agent checks the checkout with `./scripts/repo-preflight.sh`, starts a feature branch from refreshed `main`, implements the rule with a regression test, and opens a ready PR, here #42.
3. The repository declares its gate in `.prloop.json`, for example `{"gate": "npm test", "merge": "rebase"}`. From the PR checkout the agent runs the gate once on the pushed head and then requests review:

   ```bash
   prloop ready 42 && gh pr comment 42 --body "@codex review"
   prloop wait 42    # exits 0 when the current head is clean, 10 with findings
   ```

4. On findings, the agent fixes them with tests, pushes, replies to and resolves each thread, and repeats step 3. A coordinator handling several PRs starts `prloop run` in the background instead and checks in rarely.
5. A human reviews the clean head and merges, or authorizes `prloop run --merge rebase` to do it.

## Reusable templates

| Template | Use |
|---|---|
| [Task brief](templates/task-brief.md) | Goal, current state, allowed changes, protected inputs, and completion condition |
| [Acceptance criteria](templates/acceptance-criteria.md) | Observable behavior, failure cases, and evidence required |
| [Validation matrix](templates/validation-matrix.md) | Focused, full, security, packaging, and deployment checks |
| [Review response](templates/review-response.md) | Classify feedback and record the fix and validation without overclaiming |
| [Rollback handoff](templates/rollback-handoff.md) | Before state, exact reversal, consequences, and verification |

## Tested utilities

The repository-inspection helpers need trusted installed tools, a quiescent checkout, and stable configuration; they detect observed drift and are not a sandbox or atomic isolation boundary. See [repository safety](docs/repository-safety.md) for these prerequisites and the helpers' full behavior.

### Repository preflight

Reports root, branch, HEAD, and upstream, and fails closed on a detached head, missing upstream, or dirty state. Details: [minimum preflight](docs/repository-safety.md#minimum-preflight).

```bash
./scripts/repo-preflight.sh /path/to/repository
```

### Change-scope check

Fails when committed, local, or untracked changes fall outside an allowlist of paths and globs, including submodule contents. Details: [bound the diff](docs/repository-safety.md#bound-the-diff).

```bash
python3 scripts/check-change-scope.py --repository /path/to/repository --base origin/main --allowlist approved-paths.txt
```

### Report-redaction check

Checks text reports against named patterns without printing matched content; it is not a secret scanner. Details: [redacted evidence](docs/privacy-and-secrets.md#redacted-evidence).

```bash
python3 scripts/check-report-redaction.py --patterns synthetic-patterns.tsv report.txt
```

### Review wait loop (`prloop`)

Polls PRs, gates review requests and starts a fresh agent only when there is work, so waiting on a reviewer bot costs few model tokens. Details: [the prloop reference](tools/prloop/README.md), [what each command reads and writes](tools/prloop/README.md#what-each-command-reads-and-writes), and [the review wait loop](docs/review-wait-loop.md).

```bash
prloop run --repo owner/name --pr 42,43 --gate "npm test" --deadline 6h &   # background job of your shell
```

### Git identity guard

A global Git hook that refuses commits, patches, and pushes with an unexpected identity or unexpected email addresses in messages, such as agent co-author trailers; it is an accident guard, not a security boundary. Details: [the Git identity guard guide](docs/git-identity-guard.md).

```bash
python3 scripts/git-identity-guard.py --help
```

The inspection utilities and the Git identity guard use only Bash, Python's standard library, and Git; `prloop` uses Node.js, Git and the GitHub CLI. Tests create temporary synthetic repositories or use fixture JSON and never contact the network. [AGENTS.md](AGENTS.md#validation) lists the validation gate. The hosted workflow runs the same gate; the local gate remains authoritative.

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
