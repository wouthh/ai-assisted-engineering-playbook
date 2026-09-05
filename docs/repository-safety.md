# Repository safety

Repository preflight protects user work and makes later evidence attributable to the correct checkout and commit.

## Minimum preflight

From a trusted checkout of this playbook, stop other repository writers and run the hardened helper before mutation:

```bash
./scripts/repo-preflight.sh /path/to/repository
```

The helper reports the root, branch, HEAD, and upstream without printing a remote URL that could contain credentials in user information, a query, or a fragment. Confirm repository identity through a trusted host UI or authenticated metadata API when that evidence is required; never retain a raw credential-bearing remote URL in a prompt or log. Then read repository guidance and inspect relevant source, tests, and current pull-request state. The included [`repo-preflight.sh`](../scripts/repo-preflight.sh) fails if the working tree is dirty, detached, lacks an upstream, or cannot be inspected reliably. Do not substitute a raw `git status` command before the helper's configuration guards: repository configuration can make Git execute hooks or content filters.

## Existing changes belong to someone

Do not reset, clean, stash, amend, or overwrite unexplained changes. Determine whether they overlap the task. If they do, stop or create an isolated worktree or clone from a verified base. If they do not, leave them untouched.

An isolated worktree is not permission to ignore drift. Record the base SHA and compare it with the live default branch immediately before pushing or merging.

## Bound the diff

For sensitive or multi-repository work, define an allowlist of files or globs. Run the [change-scope utility](../scripts/check-change-scope.py) and inspect the complete diff, including deletions and generated files.

Check both content and shape:

- unexpected paths;
- file modes and symlinks;
- generated or binary output;
- submodule changes;
- lockfile drift;
- author and committer identity;
- sensitive values in commit messages or documentation.

The scope utility compares tracked and untracked file contents as well as Git state before and after inspection, including initialized submodules. Content digests stay in memory and are never reported. Both utilities reject submodules whose configured working directory differs from their actual checkout. These checks detect observed drift; they do not lock out concurrent writers, so stop other writers and revalidate before acting on the result.

All tracked submodules must already be initialized; both tools fail closed otherwise and never initialize or fetch them. The scope check prefixes nested file paths so approving a gitlink alone does not approve edits to its files. A changed gitlink still needs its own approval. Preflight checks root and submodule operation markers again before reporting a clean result.

The root comparison uses one unambiguous merge base, including the gitlink baselines used to inspect nested changes. Porcelain status paths are included even when built-in text normalization makes a diff empty; an observed local edit still requires scope approval.

Committed, staged, and checked-out submodule targets are inspected independently, so reversing a gitlink in one surface cannot conceal a change in another. Both tools compare raw regular-file bytes with Git's expected index checkout; built-in EOL, encoding, and identifier expansion are applied to the expected bytes, not used to normalize away actual edits. Configured clean, smudge, and process drivers are rejected before this comparison, and the caller's `GIT_EXEC_PATH` override is removed. Content and digests are never printed. The installed Git and tools on the executable `PATH` must still be trusted.

Removed or replaced gitlinks are included in the scope comparison; if the old module cannot be inspected locally, the check fails closed rather than approving an opaque deletion. Preflight repeats its raw-byte comparison at the final gate, and submodule byte checks do not depend on exported Bash functions surviving an intermediate shell.

These helpers are conservative checks for a trusted, quiescent checkout, not a sandbox or an atomic isolation boundary. Their read-only behavior assumes that repository configuration and the installed tools are not changed during inspection. If that prerequisite cannot be established, do not run them against the live checkout; use a separately reviewed isolated inspection workflow. Observed-drift checks do not prove that every concurrent change was detected.

## Preserve linear evidence

Use normal follow-up commits during review. Do not amend, rebase, or force-push unless the repository workflow and task explicitly require it. A reviewer should be able to see how a finding was corrected.

Before merge, re-query the current head, base, mergeability, checks, reviews, threads, and ordinary comments. Use an expected-head guard when the platform supports it.

## Destructive Git operations

History rewriting, tag replacement, ref deletion, and branch deletion need exact targets, backup, consequence analysis, and separate approval. A normal pull request cannot remove a value from existing history.

A force-with-lease is safer than an unguarded force, but it remains destructive. For multiple refs, prefer one atomic transaction with an explicit lease for every target and stop if any lease fails.
