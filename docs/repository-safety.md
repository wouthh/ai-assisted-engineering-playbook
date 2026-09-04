# Repository safety

Repository preflight protects user work and makes later evidence attributable to the correct checkout and commit.

## Minimum preflight

Before mutation, verify:

```bash
git rev-parse --show-toplevel
git status --short --branch
git rev-parse HEAD
git remote
git remote get-url origin >/dev/null
git branch --show-current
```

The remote command verifies that `origin` resolves without printing a URL that could contain credentials in user information, a query, or a fragment. Confirm repository identity through a trusted host UI or authenticated metadata API when that evidence is required; never retain a raw credential-bearing remote URL in a prompt or log. Then read repository guidance and inspect relevant source, tests, and current pull-request state. The included [`repo-preflight.sh`](../scripts/repo-preflight.sh) performs a conservative subset and fails if the working tree is dirty, detached, lacks an upstream, or cannot be inspected reliably.

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

## Preserve linear evidence

Use normal follow-up commits during review. Do not amend, rebase, or force-push unless the repository workflow and task explicitly require it. A reviewer should be able to see how a finding was corrected.

Before merge, re-query the current head, base, mergeability, checks, reviews, threads, and ordinary comments. Use an expected-head guard when the platform supports it.

## Destructive Git operations

History rewriting, tag replacement, ref deletion, and branch deletion need exact targets, backup, consequence analysis, and separate approval. A normal pull request cannot remove a value from existing history.

A force-with-lease is safer than an unguarded force, but it remains destructive. For multiple refs, prefer one atomic transaction with an explicit lease for every target and stop if any lease fails.
