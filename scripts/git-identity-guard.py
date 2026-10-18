#!/usr/bin/env python3
"""Refuse Git operations that would record an unexpected identity or email.

Run as a global configured Git hook. The guard only reads Git state and
refuses; it never changes configuration, identities, or commits.

Identity mode (default) checks configured and effective author and committer
emails and names, plus author metadata preserved by cherry-pick and rebase. Commit
message mode (--commit-msg FILE) additionally refuses email addresses in the
message that are not on the allowlist, such as co-author trailers. Push mode
(--pre-push) also checks the author and committer email and name and the
message of every outgoing commit that no remote-tracking branch already
contains.

Optional forbidden_terms (case-insensitive substrings, such as a private name
that must never be published) are refused in commit messages, identities,
added lines and new paths of the staged change (pre-commit, pre-merge-commit
and pre-applypatch, which run without hook arguments), and in the messages,
identities, added lines and new paths of every outgoing commit and in pushed
annotated tags on push.
Refusals never print the term or the matching text.

Private values live in a local JSON configuration file, never in this script:

    {
      "expected_email": "12345+name@users.noreply.github.com",
      "allowed_names": ["Your Name"],
      "allowed_message_emails": ["release-bot@example.com"],
      "allowed_foreign_identities": ["Release Bot <release-bot@example.com>"],
      "forbidden_terms": ["zz-private-term"],
      "forbidden_terms_exempt_remotes": ["git@example.com:you/private-cv.git"]
    }

allowed_names is required: without it every guarded operation is refused.
allowed_foreign_identities is optional and only affects push mode: an outgoing
commit's author or committer that exactly matches one "Name <email>" entry is
accepted, for history that legitimately contains other people's commits. A
commit whose author and committer both match is also exempt from the message
check; every other outgoing message is checked as usual.
forbidden_terms_exempt_remotes lists exact remote URLs. A push to one of them
skips the forbidden-term checks; other operations skip them only when every
configured remote pushes to an exempt URL. A push to any other URL also
checks commits that only the tracking refs of remotes with any exempt fetch or
push URL contain.

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

Refuse Git operations whose identity (email or name) or commit message email
does not match the local guard configuration, or that contain a configured
forbidden term. Exits 0 when allowed and 1 when refused.

  --commit-msg FILE  also check email addresses in the commit message FILE
  --pre-push         also check outgoing commits read from standard input
  -h, --help         show this help and exit

Configuration: $GIT_IDENTITY_GUARD_CONFIG, or
$XDG_CONFIG_HOME/git-identity-guard/config.json, or
~/.config/git-identity-guard/config.json (see the module docstring)."""

GIT = "git"
# Avoid lock files, lazy fetches, and replacement objects while inspecting,
# and disable trace destinations so inspection never writes files.
ENV = {name: value for name, value in os.environ.items()
       if not name.startswith("GIT_TRACE")}
ENV.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1",
           # "0" also overrides trace2.*Target settings in Git configuration.
           GIT_TRACE2="0", GIT_TRACE2_EVENT="0", GIT_TRACE2_PERF="0")
ZERO_OID = re.compile(r"0+")
# Message checks fail closed: every whitespace-separated word containing "@"
# is treated as an address unless the whole word is a mention or filter token
# such as @name or @service:id (no local part and no dot after the at-sign), a
# package scope such as @scope/name, or a package version such as name@1.2.3. Unusual but valid address
# syntax is therefore refused unless it is allowlisted.
# Trim only characters that can never belong to an address at that end: an
# unquoted local part may start with any atext such as ! ' ? ` or {, but never
# with < ( [ or a quote, and a domain never ends in punctuation.
LEADING_EDGE = "<([\""
TRAILING_EDGE = ">)]},;:!?'\"`."
# @name, @name:value or @name:<placeholder> in ASCII letters, digits, _ and -
# only, so a split address such as "name @domain.tld", "name @[IPv6:...]" or
# "@x:<name @domain.tld>" stays refused; an optional backtick allows a
# Markdown code span.
MENTION = re.compile(r"`?@[A-Za-z0-9_-]+(?::(?:[A-Za-z0-9_-]+|<[A-Za-z0-9_-]+>?))?")
SCOPED_PACKAGE = re.compile(r"@[A-Za-z0-9][\w.-]*/[\w./-]*")
# A whole word such as name@1.2.3, name@v1.2.3-beta.1 or @scope/name@1.2.
PACKAGE_VERSION = re.compile(
    r"(?:@[A-Za-z0-9][\w.-]*/)?[A-Za-z0-9][\w.-]*"
    r"@v?[0-9]+(?:\.[0-9]+){0,2}(?:[-+][0-9A-Za-z.-]+)?")
CONFIG_EMAIL = re.compile(r"[^@\s]+@[^@\s]+")
CONFIG_IDENT = re.compile(r"([^<>]*[^<>\s]) <([^@\s<>]+@[^@\s<>]+)>")
GITHUB_USER_NOREPLY = re.compile(
    r"(?:[1-9][0-9]*\+)?[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?"
    r"@users\.noreply\.github\.com")
GENERIC_ALLOWED = {"noreply@github.com", "support@github.com"}
# Reserved documentation and testing domains (RFC 2606 and RFC 6761).
RESERVED_DOMAINS = ("example.com", "example.net", "example.org")
RESERVED_TLDS = (".example", ".invalid", ".test")
HOSTNAME = re.compile(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*")


class Refusal(ValueError):
    """A reason the guarded operation must not proceed."""


def git(*args: str, missing_ok: bool = False, raw: bool = False,
        stdin: str | None = None, timeout: int = 10, missing_code: int = 1):
    try:
        result = subprocess.run([GIT, "--no-optional-locks", *args], env=ENV,
                                capture_output=True, text=not raw, timeout=timeout,
                                input=stdin.encode() if raw and stdin else stdin)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Refusal("could not inspect Git identity safely") from exc
    if result.returncode:
        if missing_ok and result.returncode == missing_code:
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
    names = data.get("allowed_names") if isinstance(data, dict) else None
    foreign = data.get("allowed_foreign_identities", []) if isinstance(data, dict) else None
    terms = data.get("forbidden_terms", []) if isinstance(data, dict) else None
    exempt = data.get("forbidden_terms_exempt_remotes", []) if isinstance(data, dict) else None
    if not isinstance(expected, str) or not CONFIG_EMAIL.fullmatch(expected):
        raise Refusal("guard configuration needs a valid expected_email")
    if not isinstance(extras, list) or not all(
            isinstance(item, str) and CONFIG_EMAIL.fullmatch(item) for item in extras):
        raise Refusal("allowed_message_emails must be a list of email addresses")
    if names is None:
        raise Refusal(f"guard configuration {str(path)!r} has no allowed_names; add "
                      '"allowed_names": ["Your Name"] listing every permitted '
                      "author and committer name")
    if not isinstance(names, list) or not names or not all(
            isinstance(item, str) and item.strip() for item in names):
        raise Refusal("allowed_names must be a non-empty list of names")
    if not isinstance(foreign, list) or not all(
            isinstance(item, str) and CONFIG_IDENT.fullmatch(item) for item in foreign):
        raise Refusal('allowed_foreign_identities must be a list of "Name <email>" strings')
    for key, value in (("forbidden_terms", terms),
                       ("forbidden_terms_exempt_remotes", exempt)):
        if not isinstance(value, list) or not all(
                isinstance(item, str) and item.strip() for item in value):
            raise Refusal(f"{key} must be a list of non-empty strings")
    return {"expected": expected, "names": set(names),
            "terms": [term.lower() for term in terms], "exempt_remotes": set(exempt),
            "foreign": {CONFIG_IDENT.fullmatch(item).groups() for item in foreign},
            "message_allowed": {expected.lower(), *(e.lower() for e in extras)}}


def has_term(text: str, config: dict) -> bool:
    lower = text.lower()
    return any(term in lower for term in config["terms"])


def check_terms(text: str | None, label: str, config: dict) -> None:
    # Never print the term or the text: refusals may land in logs.
    if text and has_term(text, config):
        raise Refusal(f"{label} contains a forbidden term")


def require_email(label: str, email: str | None, config: dict) -> None:
    check_terms(email, f"{label} email", config)
    if email != config["expected"]:
        raise Refusal(f"{label} email {email!r} is not the configured address")


def require_name(label: str, name: str | None, config: dict) -> None:
    check_terms(name, f"{label} name", config)
    # Exact match: case or whitespace variants are different recorded names.
    if name not in config["names"]:
        raise Refusal(f"{label} name {name!r} is not in allowed_names")


def require_ident(label: str, name: str | None, email: str | None,
                  config: dict) -> None:
    require_email(label, email, config)
    require_name(label, name, config)


def git_path(name: str) -> pathlib.Path:
    return pathlib.Path(git("rev-parse", "--git-path", name))


def check_source_author(path: pathlib.Path, label: str, config: dict) -> None:
    if not path.is_file():
        return
    sha = path.read_text().strip()
    if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", sha):
        raise Refusal(f"could not validate {label} author source")
    # Read the raw header only: display settings, mailmaps, notes, signature
    # verification programs and message encodings must not affect this check.
    header = git("cat-file", "commit", sha, raw=True).partition(b"\n\n")[0]
    authors = [line for line in header.splitlines() if line.startswith(b"author ")]
    match = re.fullmatch(br"author ([^<>]*) <([^<>]*)> -?\d+ [+-]\d{4}", authors[0]) \
        if len(authors) == 1 else None
    if not match:
        raise Refusal(f"could not parse {label} raw identity")
    require_ident(label, match.group(1).decode("utf-8"),
                  match.group(2).decode("utf-8"), config)


def check_author_script(path: pathlib.Path, label: str, config: dict) -> None:
    if not path.is_file():
        return
    # Parse Git's shell-quoted data as text. Never execute/source this file.
    tokens = shlex.split(path.read_text(), comments=False, posix=True)
    emails = [t.split("=", 1)[1] for t in tokens if t.startswith("GIT_AUTHOR_EMAIL=")]
    names = [t.split("=", 1)[1] for t in tokens if t.startswith("GIT_AUTHOR_NAME=")]
    if len(emails) != 1 or len(names) != 1:
        raise Refusal(f"could not validate {label} author metadata")
    require_ident(label, names[0], emails[0], config)


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


def check_identity(config: dict) -> None:
    # Catch a wrong default even when role-specific settings happen to mask it.
    for key in ("user.email", "author.email", "committer.email"):
        email = git("config", "--get", key, missing_ok=True)
        if email is None and key != "user.email":
            continue
        require_email(key, email, config)
    for key in ("user.name", "author.name", "committer.name"):
        name = git("config", "--get", key, missing_ok=True)
        if name is None and key != "user.name":
            continue
        require_name(key, name, config)

    for role in ("COMMITTER", "AUTHOR"):
        ident = git("var", f"GIT_{role}_IDENT")
        match = re.fullmatch(r"([^<>]*) <([^<>]*)> -?\d+ [+-]\d{4}", ident)
        if not match:
            raise Refusal(f"could not parse effective {role.lower()} identity")
        require_ident(role.lower(), match.group(1), match.group(2), config)

    # The sequencer can pass a preserved author directly to commit-tree without
    # exporting it to the prepare-commit-msg hook. Inspect its local source too.
    check_source_author(git_path("CHERRY_PICK_HEAD"), "cherry-pick source author",
                        config)
    for directory in ("rebase-merge", "rebase-apply"):
        folder = git_path(directory)
        if not folder.is_dir():
            continue
        check_author_script(folder / "author-script", f"{directory} author", config)
        check_source_author(git_path("REBASE_HEAD"), "rebase source author", config)
        for name in ("stopped-sha", "original-commit"):
            check_source_author(folder / name, f"{directory} source author", config)


def message_email_allowed(email: str, allowed: set[str]) -> bool:
    lower = email.lower()
    if lower.count("@") != 1:
        return False  # Never let a trailing allowed address vouch for a prefix.
    if lower in allowed or lower in GENERIC_ALLOWED:
        return True
    if GITHUB_USER_NOREPLY.fullmatch(lower):
        return True
    # Reserved names count only when the whole part after @ is a hostname,
    # so a URL that merely ends in a reserved suffix is not accepted.
    domain = lower.partition("@")[2]
    return HOSTNAME.fullmatch(domain) is not None and (
        domain in RESERVED_DOMAINS or domain.endswith(RESERVED_TLDS))


def message_addresses(text: str) -> list[tuple[int, str]]:
    """(line number, word) pairs that must be treated as addresses.

    The whole message is tokenized at once. Text between < and >, the form Git
    trailers use, is rejoined exactly across whitespace and lines and checked
    as one address without exemptions. Elsewhere a standalone at-sign is
    checked together with its neighbouring words.
    """
    raw = [(text.count("\n", 0, match.start()) + 1, match.group())
           for match in re.finditer(r"[^\s,;]+", text)]
    found = []
    index = 0
    while index < len(raw):
        number, token = raw[index]
        if token.startswith("<"):
            parts = [token]
            while ">" not in parts[-1] and index + 1 < len(raw):
                index += 1
                parts.append(raw[index][1])
            joined = "".join(parts)
            inner = joined[1:joined.index(">")] if ">" in joined else joined[1:]
            if "@" in inner:
                found.append((number, inner))
            index += 1
            continue
        word = token.lstrip(LEADING_EDGE).rstrip(TRAILING_EDGE)
        if word == "@":
            # "name @ domain" is one folded address; check it as a whole.
            before = raw[index - 1][1] if index > 0 else ""
            after = raw[index + 1][1] if index + 1 < len(raw) else ""
            if any(mark in before + after for mark in "()"):
                # A comment beside the at-sign hides the real local part or
                # domain; keep the raw text so it can never match the allowlist.
                found.append((number, f"{before}@{after}"))
            else:
                found.append((number, f"{before.lstrip(LEADING_EDGE)}@"
                                      f"{after.rstrip(TRAILING_EDGE)}"))
            index += 1
            continue
        index += 1
        if "@" not in word:
            continue
        # Exemptions apply only when the whole word has exactly that shape.
        # Anything else, including a split address such as "name @domain" or
        # "name@ domain", must match the allowlist and is refused otherwise.
        # A placeholder such as @name:<id> must close within the same token.
        if MENTION.fullmatch(word) and ("<" not in word or ">" in token):
            continue  # A mention such as @name, @level:error or @service:<id>.
        if SCOPED_PACKAGE.fullmatch(word):
            continue  # A scope such as @scope/name.
        if PACKAGE_VERSION.fullmatch(word):
            continue  # A package version such as name@1.2.3 or @scope/name@1.2.3.
        found.append((number, word))
    return found


def check_message_text(text: str, allowed: set[str], label: str) -> None:
    # Comment lines are checked: the hook cannot tell whether Git will strip
    # them (it keeps them for `git commit -m`, for example).
    for number, email in message_addresses(text):
        if not message_email_allowed(email, allowed):
            raise Refusal(f"{label} line {number} contains email "
                          f"{email!r}, which is not on the allowlist")


def kept_message(text: str, comments: bool) -> str:
    """The message without the verbose diff Git drops, and its comments.

    `git commit -v` appends the diff below a scissors line, and Git's editor
    template lists branch and path names as comment lines. Git keeps a
    scissors line and the text below it otherwise (as with `git commit -m`),
    so the message is cut only where the verbose diff header follows it.
    Comment lines may survive too, so `comments=False` is only safe where the
    push check still inspects the stored message.
    """
    comment = (git("config", "--get", "core.commentString", missing_ok=True)
               or git("config", "--get", "core.commentChar", missing_ok=True) or "#")
    if comment == "auto":
        return text  # Git picks the character per message; check every line.
    scissors = f"{comment} {'-' * 24} >8 {'-' * 24}"
    # Git splits lines only at \n; splitlines() would also break at U+2028
    # and similar, turning part of a kept line into a dropped comment.
    lines = text.split("\n")
    kept = []
    for number, line in enumerate(lines):
        if line == scissors:
            below = [rest for rest in lines[number + 1:] if not rest.startswith(comment)]
            if below[:1] and below[0].startswith("diff --git "):
                break
        if comments or not line.startswith(comment):
            kept.append(line)
    return "\n".join(kept)


def check_message(path: pathlib.Path, config: dict) -> None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise Refusal("could not read the commit message") from exc
    # Terms first, so an email refusal never echoes a word containing one:
    # that includes refused addresses on comment lines the term check skips.
    full = kept_message(text, comments=True)
    check_terms(kept_message(text, comments=False), "commit message", config)
    check_terms(" ".join(email for _, email in message_addresses(full)
                         if not message_email_allowed(email, config["message_allowed"])),
                "commit message", config)
    check_message_text(full, config["message_allowed"], "commit message")


def remote_urls() -> dict[str, dict[str, list[str]]]:
    """Configured remotes by name, each with its fetch and push URLs.

    Git resolves them after url.<base>.insteadOf and pushInsteadOf, as it does
    for the URL it passes to the pre-push hook (a push URL falls back to the
    fetch URL). `git remote` also lists names that only have other settings,
    such as a global remote.origin.prune; get-url exits 2 for those and they
    have no URL to push to, so they are skipped.
    """
    remotes = {}
    for name in git("remote").split():
        urls = {kind: git("remote", "get-url", *flags, "--all", name,
                          missing_ok=True, missing_code=2)
                for kind, flags in (("url", ()), ("pushurl", ("--push",)))}
        if None not in urls.values():
            remotes[name] = {kind: value.splitlines() for kind, value in urls.items()}
    return remotes


def push_urls() -> list[str]:
    """URLs a push to any configured remote goes to."""
    return [url for kinds in remote_urls().values() for url in kinds["pushurl"]]


def terms_exempt(config: dict, push_url: str | None) -> bool:
    # A push is exempt only when its actual destination is; other operations
    # only when every remote a later push could reach is exempt.
    if push_url is not None:
        return push_url in config["exempt_remotes"]
    urls = push_urls()
    return bool(urls) and all(url in config["exempt_remotes"] for url in urls)


# --text also checks files that .gitattributes marks binary or -diff.
DIFF_OPTIONS = ("--patch-with-raw", "-U0", "-M", "--text", "--no-color", "--no-ext-diff",
                "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/")
COMMIT_LINE = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def check_patch(patch: str, config: dict, where: str = "") -> None:
    """Check new paths (raw lines) and added lines of a patch.

    `git diff-tree --stdin` output starts each commit with its id, which sets
    the label. Lines split only at newlines, as binary content may hold other
    line-break characters.
    """
    path = ""
    in_hunk = False
    for line in patch.split("\n"):
        if COMMIT_LINE.fullmatch(line):
            where, in_hunk = f" in commit {line[:12]}", False
        elif line.startswith(":") and not in_hunk:
            status, *paths = line.split("\t")
            if status.split()[-1][:1] in "ARC" and has_term(paths[-1], config):
                raise Refusal(f"a file path{where} contains a forbidden term")
        elif line.startswith("diff --git "):
            in_hunk = False
        elif line.startswith("+++ ") and not in_hunk:
            path = line[4:].removeprefix("b/")
        elif line.startswith("@@"):
            in_hunk = True
        elif in_hunk and line.startswith("+") and has_term(line[1:], config):
            label = "a file path" if has_term(path, config) else repr(path)
            raise Refusal(f"an added line in {label}{where} contains a forbidden term")


def check_staged(config: dict) -> None:
    # Without a HEAD (unborn branch) this shows every staged file.
    patch = git("-c", "core.quotePath=false", "diff", "--cached", *DIFF_OPTIONS,
                raw=True, timeout=120)
    check_patch(patch.decode("utf-8", "replace"), config, " of the staged change")


def check_outgoing(updates: str, config: dict) -> None:
    """Check commits a push would publish that no checked remote-tracking ref has."""
    outgoing = []
    # Commits only an exempt remote has were never term-checked, so they are
    # outgoing too. Only the default tracking refs of remotes without any
    # exempt fetch or push URL count as checked; refs anywhere else (another
    # fetch refspec, or an exempt remote's namespace) do not.
    published = ["--remotes"]
    if config["terms"]:
        exempt, checked = [], []
        for name, kinds in remote_urls().items():
            # Escaped, so a configured remote name never matches as a pattern.
            pattern = "refs/remotes/" + re.sub(r"([*?[\\])", r"\\\1", name) + "/*"
            (exempt if any(url in config["exempt_remotes"] for urls in kinds.values()
                           for url in urls) else checked).append(pattern)
        # The * also matches slashes, so refs/remotes/a/* covers an exempt
        # remote named a/b; exclusions apply only to the next --glob.
        published = [arg for pattern in checked
                     for arg in (*(f"--exclude={e}" for e in exempt), f"--glob={pattern}")]
    for line in updates.splitlines():
        fields = line.split()
        if len(fields) != 4:
            raise Refusal("could not parse the pre-push update list")
        local_oid = fields[1]
        if ZERO_OID.fullmatch(local_oid):
            continue  # Branch deletion: nothing is published.
        check_terms(f"{fields[0]} {fields[2]}", "a pushed ref name", config)
        # An annotated tag publishes its own message and tagger, possibly
        # through a chain of tags; rev-list below only sees the commits.
        oid = local_oid
        while config["terms"] and git("cat-file", "-t", oid) == "tag":
            tag = git("cat-file", "tag", oid, raw=True).decode("utf-8", "replace")
            check_terms(tag, f"tag {oid[:12]}", config)
            oid = tag.partition("\n")[0].removeprefix("object ")
        commits = git("rev-list", local_oid, "--not", *published)
        for commit in commits.split():
            outgoing.append(commit)
            raw = git("cat-file", "commit", commit, raw=True)
            header, _, body = raw.partition(b"\n\n")
            foreign_roles = 0
            for role in (b"author", b"committer"):
                match = re.search(rb"^" + role + rb" ([^<>\n]*) <([^<>]*)> -?\d+ [+-]\d{4}$",
                                  header, re.MULTILINE)
                if not match:
                    raise Refusal(f"could not parse {role.decode()} of commit {commit[:12]}")
                name = match.group(1).decode("utf-8", "replace")
                email = match.group(2).decode("utf-8", "replace")
                check_terms(f"{name} <{email}>",
                            f"commit {commit[:12]} {role.decode()} identity", config)
                # Exact name and email, so a known bot name with another
                # address is still refused.
                if (name, email) in config["foreign"]:
                    foreign_roles += 1
                    continue
                require_ident(f"commit {commit[:12]} {role.decode()}", name, email, config)
            message = body.decode("utf-8", "replace")
            check_terms(message, f"commit {commit[:12]} message", config)
            if foreign_roles == 2:
                # Written and committed entirely by others (a bot commit merged
                # on the hosting platform); its message is not ours to police.
                continue
            check_message_text(message, config["message_allowed"],
                               f"commit {commit[:12]} message")
    if outgoing and config["terms"]:
        # One pass over all outgoing diffs, each against its first parent
        # (root commits against the empty tree).
        patch = git("-c", "core.quotePath=false", "diff-tree", "--stdin", "--root",
                    "--diff-merges=first-parent", *DIFF_OPTIONS, raw=True,
                    stdin="\n".join(dict.fromkeys(outgoing)) + "\n", timeout=300)
        check_patch(patch.decode("utf-8", "replace"), config)


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
        # Git passes the remote name and the URL actually pushed to.
        push_url = (argv[2] if len(argv) > 2 else "") if push else None
        if config["terms"] and terms_exempt(config, push_url):
            config["terms"] = []
        check_identity(config)
        if message is not None:
            check_message(message, config)
        elif not push and len(argv) == 0 and config["terms"]:
            # pre-commit, pre-merge-commit and pre-applypatch run without
            # arguments; prepare-commit-msg passes the message file.
            check_staged(config)
        if push:
            check_outgoing(updates, config)
    except (Refusal, OSError, UnicodeError) as exc:
        print(f"Git identity guard: refusing this operation: {exc}.", file=sys.stderr)
        print("Use the configured email and an allowed name for user, author and "
              "committer settings, only allowed emails in commit messages, and no "
              "forbidden terms in messages, identities or added content. "
              "This guard does not change identities or rewrite commits.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
