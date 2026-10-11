# Git identity guard

`scripts/git-identity-guard.py` is a global Git hook that refuses commits, merges, patches and pushes when they would record an unexpected author or committer email, or when a commit message contains an email address that is not on an allowlist. It is useful when AI coding agents commit on your behalf: agents can inherit the wrong identity from a sandbox or tool default, and some add co-author trailers with their own address.

The guard only reads Git state and exits non-zero to refuse. It never changes configuration, identities or commits, and it needs only Python's standard library and a Git release that supports configuration-based hooks. Older releases accept the `hook.<name>.*` keys but silently ignore them; after installing, confirm that `git hook list commit-msg` names the guard.

## What it checks

Identity mode (default):

- `user.email`, `author.email` and `committer.email` from the effective Git configuration;
- the effective author and committer identity (`git var`), which includes `GIT_AUTHOR_*` and `GIT_COMMITTER_*` environment overrides;
- author metadata preserved by cherry-pick and rebase, read from raw commit headers and Git's operation files without executing them.

Commit message mode (`--commit-msg FILE`) runs the identity checks and then refuses any email address in the message that is not allowed. Every line is checked, including comment lines: a hook cannot tell whether Git will strip them, and `git commit -m` keeps them. As a consequence, `git commit -v` is refused when the included diff contains an address that is not allowed. The check fails closed: every word that contains `@` (words are split at whitespace, commas and semicolons, then trimmed of opening brackets and quotes at the start and of closing brackets and punctuation at the end; characters that are valid at the start of an address, such as `!`, `'` or `{`, are kept) is treated as an address, unless the whole word is a mention such as `@name` (letters, digits, `_` and `-` only), a package scope such as `@scope/name`, or a package version of the form `name@MAJOR[.MINOR[.PATCH]][-prerelease]`, optionally scoped as `@scope/name@1.2.3`. Addresses with a numeric host such as `user@127.0.0.1`, addresses split by whitespace such as `name @domain`, and dotted decorators such as `@pytest.fixture` are therefore refused. An allowed address must be the entire word, with exactly one `@`. Unusual address syntax, quoted local parts, domain literals and URLs with user information are therefore refused unless they match the allowlist exactly. Allowed addresses are:

- the configured `expected_email` and any `allowed_message_emails`;
- GitHub's generic `noreply` and `support` addresses and `users.noreply.github.com` addresses;
- reserved documentation domains: `example.com`, `example.net`, `example.org`, and names ending in `.example`, `.invalid` or `.test`.

Push mode (`--pre-push`) runs the identity checks and then reads the update list Git supplies on standard input. Every outgoing commit that no remote-tracking branch already contains must have the expected author and committer email and an allowed message. Commits that other people wrote are accepted once they are reachable from a remote-tracking branch, so fetch them into one before pushing a branch that contains them.

A repository whose Git directory is under `/tmp`, `/var/tmp` or `$TMPDIR`, and which has no remote URL, is treated as disposable and skipped. Test suites that create throwaway repositories with synthetic identities therefore keep working. Push mode never uses this exemption, because `git push <url>` publishes even from a repository without a configured remote. `$TMPDIR` is ignored when it is your home directory or one of its parents. Worktrees of real repositories keep their Git directory elsewhere and stay guarded.

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

Copy the script to a stable location, write the configuration, then register three configured hooks in your global Git configuration:

```bash
install -D -m 755 scripts/git-identity-guard.py ~/.local/lib/git-identity-guard/git-identity-guard.py
# Hook commands are run by /bin/sh, so store a POSIX single-quoted path.
guard_path="$HOME/.local/lib/git-identity-guard/git-identity-guard.py"
guard="'$(printf '%s' "$guard_path" | sed "s/'/'\\\\''/g")'"

git config --global hook.identity-guard.command "$guard"
for event in pre-commit pre-merge-commit pre-applypatch prepare-commit-msg; do
  git config --global --add hook.identity-guard.event "$event"
done

git config --global hook.identity-message-guard.command "$guard --commit-msg"
git config --global --add hook.identity-message-guard.event commit-msg
git config --global --add hook.identity-message-guard.event applypatch-msg

git config --global hook.identity-push-guard.command "$guard --pre-push"
git config --global hook.identity-push-guard.event pre-push
```

`commit-msg` covers `git commit` and `git merge`; `applypatch-msg` covers patches applied with `git am`.

Configured hooks run in addition to `core.hooksPath` and repository hooks, so existing project hooks keep working. Check the setup with `git hook run commit-msg -- <message-file>` in a repository, or by committing a test message in a scratch repository that has a remote URL.

## Limits

This is an accident guard, not a security boundary.

- `git commit --no-verify` skips `pre-commit` and `commit-msg`, so message checks are bypassed at commit time. `prepare-commit-msg` still runs the identity checks, and the push check inspects the outgoing commits unless `git push --no-verify` is used too.
- Anyone who can edit their own Git configuration, the script or the configuration file can disable the guard.
- Commits created on a hosting platform, such as a squash merge in the GitHub web interface, never run local hooks. Review the merge message there, or enforce the rule in a server-side check.
- The message check looks for email addresses only. It does not judge trailer names or other attribution text.

## Rollback

Remove the hooks with `git config --global --remove-section hook.identity-guard`, and the same command for `hook.identity-message-guard` and `hook.identity-push-guard`. Then delete the installed script and, if you no longer need it, the configuration file.
