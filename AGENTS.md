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
python3 -m py_compile scripts/check-change-scope.py scripts/check-report-redaction.py scripts/git-identity-guard.py examples/fictional-order-service/src/order_rules.py
python3 scripts/check-change-scope.py --help
python3 scripts/check-report-redaction.py --help
node --test
./bin/prloop --help
python3 scripts/git-identity-guard.py --help
git diff --check
git diff --cached --check
```

`.prloop.json` declares the same commands joined with `&&` as the prloop gate (`light` weight, `rebase` merges) and is a working example of [per-repository prloop config](tools/prloop/README.md#per-repository-config-prloopjson). Keep it in step with this list. The hosted workflow runs the same gate; the local gate remains authoritative.

Inspect the complete staged diff before committing. Do not add generated reports, local repositories, tokens, or execution logs.

## Default delivery and guidance maintenance

Policy: `implementation-review-loop-v1`. Follow [project onboarding](docs/project-onboarding.md), the [implementation loop](docs/implementation-loop.md), and [validation and review](docs/validation-and-review.md).

- Index before editing. New work starts from refreshed upstream `main` on a feature branch; an authorized existing PR continues from its exact remote head without silent rebase or reset.
- Keep this file, the reusable AGENTS template, linked workflow documentation, and fictional walkthrough consistent when their contract changes. Preserve scoped, repository-specific review rules rather than copying every general rule into each file.
- Cross-repository playbook maintenance requires a material reusable gap and authorization for that work. Project-specific guidance changes alone do not require a playbook PR; never propagate private project details.
- For authorized publication, validate and document the change (before a PR exists, run the full gate directly once, within load and memory limits), push normal commits, open a ready PR, and verify the hosted diff. First inspect the configured automatic review, including Codex reactions on the PR body; request review only if no current cycle is running.
- Evaluate all feedback, fix valid in-scope findings, run focused checks, push, reply and resolve addressed threads, gate the pushed head through `prloop ready` (it passes only with no unresolved thread), then obtain fresh completed review of the substantive head. A bot thumbs-up must be attributable to that head; eyes, stale reactions, and silence are not clean review.
- For each completed review, record the reviewer or tool identity, whether the review was automated or human, the exact reviewed head, scope and coverage, outcome, and remaining findings. A completed clean automated review is evidence of that recorded automated outcome, not proof of human inspection. Record any actual human inspection or acceptance separately.
- `prloop` (see [the review wait loop](docs/review-wait-loop.md)) runs the gate-request-wait cycle: preferably one background `prloop run` per set of PRs with `prloop run --status` check-ins; manually, `prloop ready` (runs the gate and marks the head tested) before requesting, then `prloop wait` instead of polling.
- Start `prloop run` as a direct background job of your own shell so its exit notifies you, always with a `--deadline`, started from the repository's main checkout rather than a PR worktree that is removed after its merge. Never supervise it through a detached process plus a `pgrep -f` watcher, which can match itself and never exit.
- After a tool failure (an agent crash, timeout, missing tool or permission, not real review rounds), read the agent log named in the event and clear that PR's state file before rerunning, instead of spending `prloop reset-rounds`.
- Subagents sharing a coordinator's scratch directory work only in their own `mktemp -d` directory under its `agents/` (see [task-end cleanup](docs/implementation-loop.md#task-end-cleanup)); agent counts and gate slots follow [the review wait loop](docs/review-wait-loop.md).
- Incorrect findings need evidence before resolution; ambiguous or disputed security findings remain open. Use bounded waits and an exact-head handoff when review is unavailable.
- Leave clean PRs for human review unless GitHub merging is explicitly authorized. Never self-approve or bypass repository requirements.

## Code Review Rules

- Flag actual side effects, secret disclosure, or false success within the helpers' documented trusted-tool, quiescent-checkout boundary. They do not promise sandboxing or atomic isolation against concurrent writers; any broader requirement needs an explicit design decision, not a claim of protection from repeated checks alone.
- Scope checks must include committed, staged, unstaged, untracked, renamed/deleted, and nested submodule paths, or fail closed when they cannot be inspected. A gitlink allowlist entry alone does not approve every nested file.
- Review-completion guidance must distinguish a current-head clean bot signal from acknowledgement, silence, stale reactions, and human approval. Mechanical formatting checks belong in validation, not stylistic review churn.
- Judge commit identity only from GitHub's record of the exact PR commit, never from commits created inside the review environment.

<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->
