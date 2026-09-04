#!/usr/bin/env python3
"""Verify that committed, local, and untracked changes stay in an allowlist."""

from __future__ import annotations

import argparse
import fnmatch
import subprocess
import sys
from pathlib import Path, PurePosixPath


def git_paths(repository: Path, *arguments: str) -> set[str]:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=True,
        stdout=subprocess.PIPE,
    )
    return {item.decode("utf-8", "surrogateescape") for item in result.stdout.split(b"\0") if item}


def load_rules(path: Path) -> list[str]:
    rules = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#"):
            candidate = PurePosixPath(line)
            if candidate.is_absolute() or ".." in candidate.parts:
                raise ValueError(f"unsafe allowlist rule: {line}")
            rules.append(line)
    if not rules:
        raise ValueError("allowlist contains no rules")
    return rules


def is_allowed(path: str, rules: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, rule) for rule in rules)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--base", required=True)
    parser.add_argument("--allowlist", type=Path, required=True)
    args = parser.parse_args()

    try:
        rules = load_rules(args.allowlist)
        changed = git_paths(args.repository, "diff", "--name-only", "-z", f"{args.base}...HEAD")
        changed |= git_paths(args.repository, "diff", "--cached", "--name-only", "-z")
        changed |= git_paths(args.repository, "diff", "--name-only", "-z")
        changed |= git_paths(args.repository, "ls-files", "--others", "--exclude-standard", "-z")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"scope-check: {error}", file=sys.stderr)
        return 2

    unexpected = sorted(path for path in changed if not is_allowed(path, rules))
    for path in sorted(changed):
        state = "allowed" if path not in unexpected else "unexpected"
        print(f"{state}\t{path}")

    if unexpected:
        print(f"scope-check: {len(unexpected)} path(s) outside the allowlist", file=sys.stderr)
        return 1

    print(f"scope-check: {len(changed)} changed path(s) allowed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
