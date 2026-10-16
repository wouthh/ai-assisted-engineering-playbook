# Git identity guard

`scripts/git-identity-guard.py` is a global Git hook that refuses commits, merges, patches and pushes when they would record an unexpected author or committer email or a name outside an allowlist, or when a commit message contains an email address that is not on an allowlist. It can also refuse configured forbidden terms, such as a private name, before they are committed or pushed. It is useful when AI coding agents commit on your behalf: agents can inherit the wrong identity from a sandbox or tool default (an email, or a name such as a tool or bot name), and some add co-author trailers with their own address.

The guard only reads Git state and exits non-zero to refuse. It never changes configuration, identities or commits, and it needs only Python's standard library and a Git release that supports configuration-based hooks. Older releases accept the `hook.<name>.*` keys but silently ignore them; after installing, confirm that `git hook list commit-msg` names the guard.

## What it checks

Identity mode (default):

- `user.email`, `author.email` and `committer.email` from the effective Git configuration must equal `expected_email`;
- `user.name`, `author.name` and `committer.name` from the effective Git configuration must each be in `allowed_names`;
- the effective author and committer identity (`git var`), which includes `GIT_AUTHOR_*` and `GIT_COMMITTER_*` environment overrides, must have the expected email and an allowed name;
- author email and name preserved by cherry-pick and rebase, read from raw commit headers and Git's operation files without executing them.

Names match exactly: a different case, extra whitespace or another spelling is a different name and must be listed separately.

Commit message mode (`--commit-msg FILE`) runs the identity checks and then refuses any email address in the message that is not allowed. Every line is checked, including comment lines: a hook cannot tell whether Git will strip them, and `git commit -m` keeps them. As a consequence, `git commit -v` is refused when the included diff contains an address that is not allowed. The check fails closed. Text between `<` and `>`, the form Git trailers such as `Co-authored-by: Name <address>` use, is rejoined exactly across whitespace and lines and must match the allowlist as a whole; this is also where unusual allowlisted addresses such as quoted local parts or domain literals are matched. Outside angle brackets, every word that contains `@` (words are split at whitespace, commas and semicolons, then trimmed of opening brackets and quotes at the start and of closing brackets and punctuation at the end; characters that are valid at the start of an address, such as `!`, `'` or `{`, are kept) is treated as an address, unless the whole word is a mention such as `@name` (letters, digits, `_` and `-` only), a package scope such as `@scope/name`, or a package version of the form `name@MAJOR[.MINOR[.PATCH]][-prerelease]`, optionally scoped as `@scope/name@1.2.3`. Addresses with a numeric host such as `user@127.0.0.1`, addresses split by whitespace such as `name @domain` or `name @ domain` (a standalone `@` joins its neighbouring words, even across lines), and dotted decorators such as `@pytest.fixture` are therefore refused. An allowed address must be the entire word, with exactly one `@`. Unusual address syntax, quoted local parts, domain literals and URLs with user information are therefore refused unless they match the allowlist exactly. Allowed addresses are:

- the configured `expected_email` and any `allowed_message_emails`;
- GitHub's generic `noreply` and `support` addresses and `users.noreply.github.com` addresses;
- reserved documentation domains: `example.com`, `example.net`, `example.org`, and names ending in `.example`, `.invalid` or `.test`.

Push mode (`--pre-push`) runs the identity checks and then reads the update list Git supplies on standard input. Every outgoing commit that no remote-tracking branch already contains must have the expected author and committer email, author and committer names in `allowed_names`, and an allowed message. Commits that other people wrote are accepted once they are reachable from a remote-tracking branch, so fetch them into one before pushing a branch that contains them.

After a history rewrite every commit is new to the remote, so third-party commits such as hosting-platform merges and dependency-bot updates are outgoing again. List those identities in `allowed_foreign_identities`: an outgoing author or committer whose exact name and email match an entry is accepted, and the other role of that commit is checked as usual. A commit whose author and committer both match an entry is also exempt from the message check, because its message was written and committed elsewhere (bot messages often contain the bot's own address and package names such as `@scope/name`). Every other outgoing message is checked as usual. The list never applies to your own configured or effective identity in any mode.

Forbidden terms (optional `forbidden_terms`) are matched as case-insensitive substrings. When terms are configured, the guard refuses:

- commit messages (`commit-msg` and `applypatch-msg`) and configured or effective author and committer names and emails that contain a term;
- added lines and added, renamed or copied file paths of the staged change, in `pre-commit`, `pre-merge-commit` and `pre-applypatch` (the hooks that run without arguments; `prepare-commit-msg` skips this check). For a merge this is the merge result against the current branch;
- in push mode, the message, author, committer, added lines and new file paths of every outgoing commit, each diffed against its first parent (root commits against the empty tree) in one `git diff-tree` pass. The message and tagger of a pushed annotated tag (and of any tag it points to) and the local and remote names of every pushed ref are checked too.

Removed lines and binary files are not checked. Refusals never print the term or the matching line: they name the commit message, the file path (or "a file path" when the path itself contains the term) and the commit. A push whose destination URL is listed in `forbidden_terms_exempt_remotes` skips the term checks, for repositories that legitimately contain a term, such as a private CV. Commit-time checks are skipped only when every configured remote pushes to a listed URL (its push URL, otherwise its URL), so a repository that also has a public remote is still checked. A push to any other URL also checks commits that so far only the tracking refs of a remote with any listed fetch or push URL contain, since a push or fetch through that URL never checked them for terms.

A repository whose Git directory is under `/tmp`, `/var/tmp` or `$TMPDIR`, and which has no remote URL, is treated as disposable and skipped. Test suites that create throwaway repositories with synthetic identities therefore keep working. Push mode never uses this exemption, because `git push <url>` publishes even from a repository without a configured remote. `$TMPDIR` is ignored when it is your home directory or one of its parents. Worktrees of real repositories keep their Git directory elsewhere and stay guarded.

## Configuration

Personal values live in a private JSON file, never in the script:

```json
{
  "expected_email": "12345+your-name@users.noreply.github.com",
  "allowed_names": ["Your Name"],
  "allowed_message_emails": [],
  "allowed_foreign_identities": ["GitHub <noreply@github.com>"],
  "forbidden_terms": ["Exampleson"],
  "forbidden_terms_exempt_remotes": ["git@github.com:your-name/private-cv.git"]
}
```

`allowed_names` is required and must be a non-empty list. A configuration without it refuses every guarded operation with a message naming the key, so upgrading the script without updating the configuration fails closed rather than silently skipping name checks. Add every name you commit under, for example `"allowed_names": ["Your Name"]`.

`allowed_foreign_identities` is optional; without it no foreign identity is accepted. When present it must be a list of `"Name <email>"` strings, matched exactly (a different name, email or case does not match). Any other shape refuses every guarded operation.

`forbidden_terms` and `forbidden_terms_exempt_remotes` are optional; without `forbidden_terms` no term is checked. When present each must be a list of non-empty strings; any other shape refuses every guarded operation. Exempt remotes match the configured URL exactly, as `git remote -v` shows it.

The guard reads `$GIT_IDENTITY_GUARD_CONFIG` if set, otherwise `$XDG_CONFIG_HOME/git-identity-guard/config.json`, otherwise `~/.config/git-identity-guard/config.json`. A missing or invalid file, including one without `allowed_names`, refuses every guarded operation, so a broken setup fails closed. Keep the file readable only by you (`chmod 600`).

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
- Forbidden terms are found only as written: a term split across lines, encoded, inside a binary file, or in history that a remote-tracking branch already contains is not detected. Large pushes are checked in one diff, which takes longer for very large histories; Git calls that exceed their time limit refuse the push.

## Rollback

Remove the hooks with `git config --global --remove-section hook.identity-guard`, and the same command for `hook.identity-message-guard` and `hook.identity-push-guard`. Then delete the installed script and, if you no longer need it, the configuration file.
