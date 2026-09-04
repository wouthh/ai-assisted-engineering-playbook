#!/usr/bin/env python3
"""Verify that committed, local, and untracked changes stay in an allowlist."""

from __future__ import annotations

import argparse
import fnmatch
from functools import lru_cache
import json
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath


GIT_READ_ONLY = [
    "git",
    "--no-optional-locks",
    "--no-replace-objects",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.trustctime=true",
    "-c",
    "core.checkStat=default",
    "-c",
    "core.ignoreStat=false",
    "-c",
    "core.fileMode=true",
    "-c",
    "core.ignoreCase=false",
    "-c",
    "advice.graftFileDeprecated=false",
]
GIT_LOCAL_ENVIRONMENT = (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
)


def git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in GIT_LOCAL_ENVIRONMENT:
        environment.pop(name, None)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    environment["GIT_NO_LAZY_FETCH"] = "1"
    environment["GIT_GRAFT_FILE"] = os.devnull
    return environment


def git_paths(repository: Path, *arguments: str) -> set[str]:
    result = subprocess.run(
        [*GIT_READ_ONLY, "-C", str(repository), *arguments],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
    )
    return {item.decode("utf-8", "surrogateescape") for item in result.stdout.split(b"\0") if item}


def repository_root(repository: Path) -> Path:
    result = subprocess.run(
        [*GIT_READ_ONLY, "-C", str(repository), "rev-parse", "--show-toplevel"],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="surrogateescape",
    )
    return Path(result.stdout.strip())


def resolve_commit(repository: Path, revision: str) -> str:
    if not revision or revision.startswith("-"):
        raise ValueError("base must name a commit and cannot start with '-'")
    result = subprocess.run(
        [
            *GIT_READ_ONLY,
            "-C",
            str(repository),
            "rev-parse",
            "--verify",
            "--end-of-options",
            f"{revision}^{{commit}}",
        ],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
        text=True,
        encoding="ascii",
    )
    return result.stdout.strip()


def hidden_index_path_count(repository: Path) -> int:
    result = subprocess.run(
        [
            *GIT_READ_ONLY,
            "-C",
            str(repository),
            "ls-files",
            "--recurse-submodules",
            "-v",
            "-z",
        ],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
    )
    count = 0
    for entry in result.stdout.split(b"\0"):
        if not entry:
            continue
        tag = chr(entry[0])
        if tag == "S" or tag.islower():
            count += 1
    return count


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


def matches_rule(path: str, rule: str) -> bool:
    path_parts = PurePosixPath(path).parts
    rule_parts = PurePosixPath(rule).parts

    @lru_cache(maxsize=None)
    def matches(path_index: int, rule_index: int) -> bool:
        if rule_index == len(rule_parts):
            return path_index == len(path_parts)
        if rule_parts[rule_index] == "**":
            return matches(path_index, rule_index + 1) or (
                path_index < len(path_parts) and matches(path_index + 1, rule_index)
            )
        return (
            path_index < len(path_parts)
            and fnmatch.fnmatchcase(path_parts[path_index], rule_parts[rule_index])
            and matches(path_index + 1, rule_index + 1)
        )

    return matches(0, 0)


def is_allowed(path: str, rules: list[str]) -> bool:
    return any(matches_rule(path, rule) for rule in rules)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    parser.add_argument("--base", required=True)
    parser.add_argument("--allowlist", type=Path, required=True)
    args = parser.parse_args()

    try:
        rules = load_rules(args.allowlist)
        root = repository_root(args.repository)
        base_commit = resolve_commit(root, args.base)
        hidden_paths = hidden_index_path_count(root)
        if hidden_paths:
            raise ValueError(
                f"{hidden_paths} tracked path(s) use assume-unchanged or skip-worktree"
            )
        changed = git_paths(
            root,
            "diff",
            "--no-renames",
            "--ignore-submodules=none",
            "--name-only",
            "-z",
            f"{base_commit}...HEAD",
            "--",
        )
        changed |= git_paths(
            root,
            "diff",
            "--cached",
            "--no-renames",
            "--ignore-submodules=none",
            "--name-only",
            "-z",
        )
        changed |= git_paths(
            root,
            "diff",
            "--no-renames",
            "--ignore-submodules=none",
            "--name-only",
            "-z",
        )
        changed |= git_paths(root, "ls-files", "--full-name", "--others", "--exclude-standard", "-z")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"scope-check: {error}", file=sys.stderr)
        return 2

    unexpected = {path for path in changed if not is_allowed(path, rules)}
    for path in sorted(changed):
        state = "allowed" if path not in unexpected else "unexpected"
        print(f"{state}\t{json.dumps(path, ensure_ascii=True)}")

    if unexpected:
        print(f"scope-check: {len(unexpected)} path(s) outside the allowlist", file=sys.stderr)
        return 1

    print(f"scope-check: {len(changed)} changed path(s) allowed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
