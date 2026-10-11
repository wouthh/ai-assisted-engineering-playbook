# Git identity guard

`scripts/git-identity-guard.py` is a global Git hook that refuses commits, merges, patches and pushes when they would record an unexpected author or committer email, or when a commit message contains an email address that is not on an allowlist. It is useful when AI coding agents commit on your behalf: agents can inherit the wrong identity from a sandbox or tool default, and some add co-author trailers with their own address.

The guard only reads Git state and exits non-zero to refuse. It never changes configuration, identities or commits, and it needs only Python's standard library and a Git release that supports configuration-based hooks (`hook.<name>.command`; check with `git help config`).

## What it checks

Identity mode (default):

- `user.email`, `author.email` and `committer.email` from the effective Git configuration;
- the effective author and committer identity (`git var`), which includes `GIT_AUTHOR_*` and `GIT_COMMITTER_*` environment overrides;
- author metadata preserved by cherry-pick and rebase, read from raw commit headers and Git's operation files without executing them.

Commit message mode (`--commit-msg FILE`) runs the identity checks and then refuses any email address in the message that is not allowed. Comment lines and everything below the scissors line are ignored, as Git does. Allowed addresses are:

- the configured `expected_email` and any `allowed_message_emails`;
- GitHub's generic `noreply` and `support` addresses and `users.noreply.github.com` addresses;
- reserved documentation domains: `example.com`, `example.net`, `example.org`, and names ending in `.example`, `.invalid` or `.test`.

A repository whose Git directory is under `/tmp`, `/var/tmp` or `$TMPDIR`, and which has no remote URL, is treated as disposable and skipped. Test suites that create throwaway repositories with synthetic identities therefore keep working. `$TMPDIR` is ignored when it is your home directory or one of its parents. Worktrees of real repositories keep their Git directory elsewhere and stay guarded.

## Configuration

Personal values live in a private JSON file, never in the script:

```json
{
  "expected_email": "12345+your-name@users.noreply.github.com",
  "allowed_message_emails": []
}
```

The guard reads `$GIT_IDENTITY_GUARD_CONFIG` if set, otherwise `$XDG_CONFIG_HOME/git-identity-guard/config.json`, otherwise `~/.config/git-identity-guard/config.json`. A missing or invalid file refuses every guarded operation, so a broken setup fails closed. Keep the file readable only by you (`chmod 600`).

## Installation

Copy the script to a stable location, write the configuration, then register two configured hooks in your global Git configuration:

```bash
install -D -m 755 scripts/git-identity-guard.py ~/.local/lib/git-identity-guard/git-identity-guard.py

git config --global hook.identity-guard.command ~/.local/lib/git-identity-guard/git-identity-guard.py
for event in pre-commit pre-merge-commit pre-applypatch prepare-commit-msg pre-push; do
  git config --global --add hook.identity-guard.event "$event"
done

git config --global hook.identity-message-guard.command "$HOME/.local/lib/git-identity-guard/git-identity-guard.py --commit-msg"
git config --global hook.identity-message-guard.event commit-msg
```

Configured hooks run in addition to `core.hooksPath` and repository hooks, so existing project hooks keep working. Check the setup with `git hook run commit-msg -- <message-file>` in a repository, or by committing a test message in a scratch repository that has a remote URL.

## Limits

This is an accident guard, not a security boundary.

- `git commit --no-verify` skips `pre-commit` and `commit-msg`, so message checks are bypassed. `prepare-commit-msg` still runs the identity checks.
- Anyone who can edit their own Git configuration, the script or the configuration file can disable the guard.
- Commits created on a hosting platform, such as a squash merge in the GitHub web interface, never run local hooks. Review the merge message there, or enforce the rule in a server-side check.
- The message check looks for email addresses only. It does not judge trailer names or other attribution text.

## Rollback

Remove the two hooks with `git config --global --unset-all hook.identity-guard.event`, `git config --global --unset hook.identity-guard.command` and the same commands for `hook.identity-message-guard`. Then delete the installed script and, if you no longer need it, the configuration file.
