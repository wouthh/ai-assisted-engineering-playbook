#!/usr/bin/env python3
"""Refuse Git operations that would record an unexpected identity or email.

Run as a global configured Git hook. The guard only reads Git state and
refuses; it never changes configuration, identities, or commits.

Identity mode (default) checks configured and effective author and committer
emails, plus author metadata preserved by cherry-pick and rebase. Commit
message mode (--commit-msg FILE) additionally refuses email addresses in the
message that are not on the allowlist, such as co-author trailers. Push mode
(--pre-push) also checks the author, committer and message of every outgoing
commit that no remote-tracking branch already contains.

Private values live in a local JSON configuration file, never in this script:

    {
      "expected_email": "12345+name@users.noreply.github.com",
      "allowed_message_emails": ["release-bot@example.com"]
    }

The file is read from $GIT_IDENTITY_GUARD_CONFIG, otherwise
$XDG_CONFIG_HOME/git-identity-guard/config.json, otherwise
~/.config/git-identity-guard/config.json. A missing or invalid file refuses.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import shlex
import subprocess
import sys

USAGE = """usage: git-identity-guard.py [--commit-msg FILE | --pre-push] [HOOK-ARGUMENTS...]

Refuse Git operations whose identity or commit message email does not match
the local guard configuration. Exits 0 when allowed and 1 when refused.

  --commit-msg FILE  also check email addresses in the commit message FILE
  --pre-push         also check outgoing commits read from standard input
  -h, --help         show this help and exit

Configuration: $GIT_IDENTITY_GUARD_CONFIG, or
$XDG_CONFIG_HOME/git-identity-guard/config.json, or
~/.config/git-identity-guard/config.json (see the module docstring)."""

GIT = "git"
# Avoid lock files, lazy fetches, and replacement objects while inspecting,
# and drop inherited trace destinations so inspection never writes files.
ENV = {name: value for name, value in os.environ.items()
       if not name.startswith("GIT_TRACE")}
ENV.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1")
ZERO_OID = re.compile(r"0+")
# Message checks fail closed: every whitespace-separated word containing "@"
# is treated as an address unless it starts with "@" (a mention or scoped
# package) or ends in a version such as name@1.2.3. Unusual but valid address
# syntax is therefore refused unless it is allowlisted.
WORD_EDGE = "<>()[]{},;:!?'\"`."
VERSION_SUFFIX = re.compile(r"@v?[0-9][0-9A-Za-z.+-]*")
CONFIG_EMAIL = re.compile(r"[^@\s]+@[^@\s]+")
GITHUB_USER_NOREPLY = re.compile(
    r"(?:[1-9][0-9]*\+)?[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?"
    r"@users\.noreply\.github\.com")
GENERIC_ALLOWED = {"noreply@github.com", "support@github.com"}
# Reserved documentation and testing domains (RFC 2606 and RFC 6761).
RESERVED_SUFFIXES = (".example", ".invalid", ".test", "@example.com",
                     "@example.net", "@example.org")


class Refusal(ValueError):
    """A reason the guarded operation must not proceed."""


def git(*args: str, missing_ok: bool = False, raw: bool = False):
    try:
        result = subprocess.run([GIT, "--no-optional-locks", *args], env=ENV,
                                capture_output=True, text=not raw, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refusal("could not inspect Git identity safely") from exc
    if result.returncode:
        if missing_ok and result.returncode == 1:
            return None
        raise Refusal("Git could not resolve the required identity metadata")
    return result.stdout if raw else result.stdout.strip()


def config_path() -> pathlib.Path:
    explicit = os.environ.get("GIT_IDENTITY_GUARD_CONFIG")
    if explicit:
        return pathlib.Path(explicit)
    base = os.environ.get("XDG_CONFIG_HOME") or str(pathlib.Path.home() / ".config")
    return pathlib.Path(base) / "git-identity-guard" / "config.json"


def load_config() -> dict:
    path = config_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Refusal(f"guard configuration {str(path)!r} is missing or invalid") from exc
    expected = data.get("expected_email") if isinstance(data, dict) else None
    extras = data.get("allowed_message_emails", []) if isinstance(data, dict) else None
    if not isinstance(expected, str) or not CONFIG_EMAIL.fullmatch(expected):
        raise Refusal("guard configuration needs a valid expected_email")
    if not isinstance(extras, list) or not all(
            isinstance(item, str) and CONFIG_EMAIL.fullmatch(item) for item in extras):
        raise Refusal("allowed_message_emails must be a list of email addresses")
    return {"expected": expected,
            "message_allowed": {expected.lower(), *(e.lower() for e in extras)}}


def require_email(label: str, email: str | None, expected: str) -> None:
    if email != expected:
        raise Refusal(f"{label} email {email!r} is not the configured address")


def git_path(name: str) -> pathlib.Path:
    return pathlib.Path(git("rev-parse", "--git-path", name))


def check_source_author(path: pathlib.Path, label: str, expected: str) -> None:
    if not path.is_file():
        return
    sha = path.read_text().strip()
    if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", sha):
        raise Refusal(f"could not validate {label} author source")
    # Read the raw header only: display settings, mailmaps, notes, signature
    # verification programs and message encodings must not affect this check.
    header = git("cat-file", "commit", sha, raw=True).partition(b"\n\n")[0]
    authors = [line for line in header.splitlines() if line.startswith(b"author ")]
    match = re.fullmatch(br"author .* <([^<>]*)> -?\d+ [+-]\d{4}", authors[0]) \
        if len(authors) == 1 else None
    if not match:
        raise Refusal(f"could not parse {label} raw identity")
    require_email(label, match.group(1).decode("utf-8"), expected)


def check_author_script(path: pathlib.Path, label: str, expected: str) -> None:
    if not path.is_file():
        return
    # Parse Git's shell-quoted data as text. Never execute/source this file.
    tokens = shlex.split(path.read_text(), comments=False, posix=True)
    emails = [t.split("=", 1)[1] for t in tokens if t.startswith("GIT_AUTHOR_EMAIL=")]
    if len(emails) != 1:
        raise Refusal(f"could not validate {label} author metadata")
    require_email(label, emails[0], expected)


def disposable_repository() -> bool:
    """Remote-less repository whose Git data lives in temporary storage.

    Test suites create such throwaway repositories with synthetic identities.
    Worktrees of real repositories share a common Git directory outside
    temporary storage, and a configured remote URL means work may be
    published, so both stay guarded.
    """
    common = pathlib.Path(git("rev-parse", "--path-format=absolute",
                              "--git-common-dir")).resolve()
    roots = [pathlib.Path("/tmp"), pathlib.Path("/var/tmp")]
    tmpdir = os.environ.get("TMPDIR")
    if tmpdir and pathlib.Path(tmpdir).is_dir():
        candidate = pathlib.Path(tmpdir).resolve()
        home = pathlib.Path.home().resolve()
        # An over-broad TMPDIR such as / or home must not exempt real work.
        if candidate != home and candidate not in home.parents:
            roots.append(candidate)
    in_temp = any(root.resolve() in common.parents for root in roots)
    # A global setting such as remote.origin.prune names a remote everywhere;
    # only a configured URL makes the repository publishable.
    return in_temp and git("config", "--get-regexp", r"^remote\..*\.(push)?url$",
                           missing_ok=True) is None


def check_identity(expected: str) -> None:
    # Catch a wrong default even when role-specific settings happen to mask it.
    for key in ("user.email", "author.email", "committer.email"):
        email = git("config", "--get", key, missing_ok=True)
        if email is None and key != "user.email":
            continue
        require_email(key, email, expected)

    for role in ("COMMITTER", "AUTHOR"):
        ident = git("var", f"GIT_{role}_IDENT")
        match = re.search(r"<([^<>]*)> -?\d+ [+-]\d{4}$", ident)
        if not match:
            raise Refusal(f"could not parse effective {role.lower()} identity")
        require_email(role.lower(), match.group(1), expected)

    # The sequencer can pass a preserved author directly to commit-tree without
    # exporting it to the prepare-commit-msg hook. Inspect its local source too.
    check_source_author(git_path("CHERRY_PICK_HEAD"), "cherry-pick source author",
                        expected)
    for directory in ("rebase-merge", "rebase-apply"):
        folder = git_path(directory)
        if not folder.is_dir():
            continue
        check_author_script(folder / "author-script", f"{directory} author", expected)
        check_source_author(git_path("REBASE_HEAD"), "rebase source author", expected)
        for name in ("stopped-sha", "original-commit"):
            check_source_author(folder / name, f"{directory} source author", expected)


def message_email_allowed(email: str, allowed: set[str]) -> bool:
    lower = email.lower()
    if lower.count("@") != 1:
        return False  # Never let a trailing allowed address vouch for a prefix.
    return (lower in allowed or lower in GENERIC_ALLOWED
            or lower.endswith(RESERVED_SUFFIXES)
            or GITHUB_USER_NOREPLY.fullmatch(lower) is not None)


def message_addresses(line: str) -> list[str]:
    """Words that must be treated as addresses (see the comment on WORD_EDGE)."""
    found = []
    for word in re.split(r"[\s,;]+", line):
        word = word.strip(WORD_EDGE)
        if "@" not in word or word.endswith("@"):
            continue
        # Exemptions apply only when the whole word has exactly that shape.
        body = word[1:] if word.startswith("@") else word
        if "@" not in body:
            continue  # A mention or decorator such as @name.
        if body.count("@") == 1 and VERSION_SUFFIX.fullmatch(body[body.index("@"):]):
            continue  # A package version such as name@1.2.3 or @scope/name@1.2.3.
        found.append(word)
    return found


def check_message_text(text: str, allowed: set[str], label: str) -> None:
    # Every line is checked: the hook cannot tell whether Git will strip
    # comment lines (it keeps them for `git commit -m`, for example).
    for number, line in enumerate(text.splitlines(), start=1):
        for email in message_addresses(line):
            if not message_email_allowed(email, allowed):
                raise Refusal(f"{label} line {number} contains email "
                              f"{email!r}, which is not on the allowlist")


def check_message(path: pathlib.Path, allowed: set[str]) -> None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise Refusal("could not read the commit message") from exc
    check_message_text(text, allowed, "commit message")


def check_outgoing(updates: str, config: dict) -> None:
    """Check commits a push would publish that no remote-tracking ref has."""
    expected = config["expected"]
    for line in updates.splitlines():
        fields = line.split()
        if len(fields) != 4:
            raise Refusal("could not parse the pre-push update list")
        local_oid = fields[1]
        if ZERO_OID.fullmatch(local_oid):
            continue  # Branch deletion: nothing is published.
        commits = git("rev-list", local_oid, "--not", "--remotes")
        for commit in commits.split():
            raw = git("cat-file", "commit", commit, raw=True)
            header, _, body = raw.partition(b"\n\n")
            for role in (b"author", b"committer"):
                match = re.search(rb"^" + role + rb" .* <([^<>]*)> -?\d+ [+-]\d{4}$",
                                  header, re.MULTILINE)
                if not match:
                    raise Refusal(f"could not parse {role.decode()} of commit {commit[:12]}")
                require_email(f"commit {commit[:12]} {role.decode()}",
                              match.group(1).decode("utf-8", "replace"), expected)
            check_message_text(body.decode("utf-8", "replace"),
                               config["message_allowed"], f"commit {commit[:12]} message")


def main(argv: list[str]) -> int:
    if argv[:1] in (["-h"], ["--help"]):
        print(USAGE)
        return 0
    message = None
    push = argv[:1] == ["--pre-push"]
    if argv[:1] == ["--commit-msg"]:
        if len(argv) < 2:
            print("git-identity-guard: --commit-msg requires a file", file=sys.stderr)
            return 2
        message = pathlib.Path(argv[1])
    try:
        # Read the push update list before any early return so Git never
        # blocks writing to a hook that did not consume its input.
        updates = sys.stdin.read() if push else ""
        # A push publishes even from a remote-less temporary repository
        # (git push <url>), so the disposable exemption never applies to it.
        if not push and disposable_repository():
            return 0
        config = load_config()
        check_identity(config["expected"])
        if message is not None:
            check_message(message, config["message_allowed"])
        if push:
            check_outgoing(updates, config)
    except (Refusal, OSError, UnicodeError) as exc:
        print(f"Git identity guard: refusing this operation: {exc}.", file=sys.stderr)
        print("Use the configured email for user, author and committer settings "
              "and in commit messages. This guard does not change identities or "
              "rewrite commits.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
