#!/usr/bin/env python3
"""Verify that committed, local, and untracked changes stay in an allowlist."""

from __future__ import annotations

import argparse
import fnmatch
from functools import lru_cache
import hashlib
import json
import os
import stat
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
    "core.symlinks=true",
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
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
)


def git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in GIT_LOCAL_ENVIRONMENT:
        environment.pop(name, None)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    environment["GIT_NO_LAZY_FETCH"] = "1"
    environment["GIT_GRAFT_FILE"] = os.devnull
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    environment["GIT_CONFIG_GLOBAL"] = os.devnull
    return environment


def git_paths(repository: Path, *arguments: str) -> set[str]:
    result = subprocess.run(
        [*GIT_READ_ONLY, "-C", str(repository), *arguments],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
    )
    return {item.decode("utf-8", "surrogateescape") for item in result.stdout.split(b"\0") if item}


def git_bytes(repository: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        [*GIT_READ_ONLY, "-C", str(repository), *arguments],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
    )
    return result.stdout


def reject_worktree_redirection(repository: Path) -> None:
    result = subprocess.run(
        [*GIT_READ_ONLY, "-C", str(repository), "config", "--get", "core.worktree"],
        check=False,
        env=git_environment(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if result.returncode == 0:
        raise ValueError("repository config redirects the worktree")
    if result.returncode != 1:
        raise subprocess.CalledProcessError(result.returncode, result.args)


def repository_root(repository: Path) -> Path:
    result = subprocess.run(
        [*GIT_READ_ONLY, "-C", str(repository), "rev-parse", "--show-toplevel"],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
    )
    if not result.stdout.endswith(b"\n"):
        raise ValueError("repository root output has no record terminator")
    root = result.stdout[:-1].decode("utf-8", "surrogateescape")
    if not root:
        raise ValueError("repository root is empty")
    return Path(root)


def configured_content_filter_count(repository: Path) -> int:
    result = subprocess.run(
        [*GIT_READ_ONLY, "-C", str(repository), "config", "--name-only", "--null", "--list"],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
    )
    names = (
        item.decode("utf-8", "surrogateescape").lower()
        for item in result.stdout.split(b"\0")
        if item
    )
    return sum(
        1
        for name in names
        if name.startswith("filter.") and name.rsplit(".", 1)[-1] in {"clean", "process"}
    )


def submodule_content_filter_count(repository: Path) -> int:
    command = r'''
      actual=$(pwd -P && printf '.') || exit 1
      configured=$(git --no-optional-locks --no-replace-objects rev-parse --show-toplevel && printf '.') || exit 1
      if [ "$actual" != "$configured" ]; then
        printf 'submodule worktree is redirected\n' >&2
        exit 1
      fi
      if ! names=$(git --no-optional-locks --no-replace-objects config --name-only --list); then
        exit 1
      fi
      while IFS= read -r name; do
        case $name in
          filter.*.clean|filter.*.process) printf 'filter\n' ;;
        esac
      done <<EOF
$names
EOF
    '''
    result = subprocess.run(
        [
            *GIT_READ_ONLY,
            "-C",
            str(repository),
            "submodule",
            "foreach",
            "--quiet",
            "--recursive",
            command,
        ],
        check=True,
        env=git_environment(),
        stdout=subprocess.PIPE,
    )
    return sum(1 for line in result.stdout.splitlines() if line == b"filter")


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


def worktree_contents(repository: Path) -> tuple:
    """Compare file bytes privately, without filters or following symlinks."""
    gitlinks = {
        entry.split(b"\t", 1)[1].decode("utf-8", "surrogateescape")
        for entry in git_bytes(repository, "ls-files", "--stage", "-z").split(b"\0")
        if entry.startswith(b"160000 ")
    }
    records = []
    for name in sorted(git_paths(
        repository, "ls-files", "--cached", "--others", "--exclude-standard", "-z"
    )):
        path = repository / name
        # Never follow a replaced parent directory outside the inspected tree.
        for parent in path.relative_to(repository).parents:
            if (repository / parent).is_symlink():
                raise ValueError("working-tree parent is a symlink")
        try:
            before = path.lstat()
        except FileNotFoundError:
            records.append((name, "absent"))
            continue
        if stat.S_ISLNK(before.st_mode):
            content = os.readlink(path)
        elif stat.S_ISREG(before.st_mode):
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or (
                    opened.st_dev, opened.st_ino
                ) != (before.st_dev, before.st_ino):
                    raise ValueError("working-tree file changed during inspection")
                digest = hashlib.sha256()
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                content = digest.digest()
        elif name in gitlinks and stat.S_ISDIR(before.st_mode):
            if (path / ".git").exists():
                if repository_root(path).resolve() != path.resolve():
                    raise ValueError("submodule worktree is redirected")
                content = repository_state(path)
            else:
                raise ValueError("tracked submodule is not initialized")
        else:
            raise ValueError("unsupported working-tree file type")
        after = path.lstat()
        if before != after:
            # Access time may change merely because this check read the file.
            fields = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")
            if any(getattr(before, field) != getattr(after, field) for field in fields):
                raise ValueError("working-tree file changed during inspection")
        records.append((name, before.st_mode, content))
    return tuple(records)


def require_initialized_submodules(repository: Path) -> None:
    if any(line.startswith(b"-") for line in git_bytes(
        repository, "submodule", "status", "--recursive"
    ).splitlines()):
        raise ValueError("tracked submodule is not initialized")


def collect_changes(repository: Path, base: str, head: str, *, nested: bool = False) -> set[str]:
    options = ("--no-renames", "--ignore-submodules=none", "--name-only", "-z")
    separator = ".." if nested else "..."
    changed = git_paths(repository, "diff", *options, f"{base}{separator}{head}", "--")
    changed |= git_paths(repository, "diff", "--cached", *options)
    unstaged = git_paths(repository, "diff", *options)
    changed |= git_paths(repository, "ls-files", "--full-name", "--others", "--exclude-standard", "-z")
    base_links = {}
    for entry in git_bytes(repository, "ls-tree", "-r", "-z", base).split(b"\0"):
        if entry.startswith(b"160000 "):
            metadata, raw_name = entry.split(b"\t", 1)
            base_links[raw_name.decode("utf-8", "surrogateescape")] = metadata.split()[2].decode("ascii")
    for entry in git_bytes(repository, "ls-files", "--stage", "-z").split(b"\0"):
        if not entry.startswith(b"160000 "):
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        _, index_commit, stage = metadata.split()
        if stage != b"0":
            raise ValueError("submodule index is unmerged")
        name = raw_name.decode("utf-8", "surrogateescape")
        submodule = repository / name
        if submodule.is_symlink():
            raise ValueError("submodule checkout is a symlink")
        if not (submodule / ".git").exists():
            raise ValueError("tracked submodule is not initialized")
        if repository_root(submodule).resolve() != submodule.resolve():
            raise ValueError("submodule worktree is redirected")
        submodule_head = resolve_commit(submodule, "HEAD")
        expected = index_commit.decode("ascii")
        if submodule_head == expected:
            # Local file edits are approved by their full paths, not the gitlink.
            unstaged.discard(name)
        submodule_base = resolve_commit(submodule, base_links.get(name, expected))
        changed |= {
            f"{name}/{path}"
            for path in collect_changes(submodule, submodule_base, submodule_head, nested=True)
        }
    return changed | unstaged


def repository_state(repository: Path) -> tuple:
    require_initialized_submodules(repository)
    return (
        resolve_commit(repository, "HEAD"),
        git_bytes(repository, "ls-files", "--stage", "-v", "-z", "--recurse-submodules"),
        git_bytes(
            repository,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ),
        worktree_contents(repository),
    )


def load_rules(path: Path) -> list[str]:
    rules = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if raw_line == "" or raw_line.startswith("#"):
            continue
        if raw_line.startswith('"'):
            line = json.loads(raw_line)
            if not isinstance(line, str):
                raise ValueError("JSON allowlist rule must be a string")
        else:
            line = raw_line
        candidate = PurePosixPath(line)
        if not line or candidate.is_absolute() or ".." in candidate.parts:
            raise ValueError(f"unsafe allowlist rule: {json.dumps(line, ensure_ascii=True)}")
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
        reject_worktree_redirection(args.repository)
        root = repository_root(args.repository)
        configured_filters = configured_content_filter_count(root)
        configured_filters += submodule_content_filter_count(root)
        if configured_filters:
            raise ValueError(
                f"{configured_filters} repository or submodule(s) configure clean/process filters"
            )
        base_commit = resolve_commit(root, args.base)
        initial_state = repository_state(root)
        head_commit = initial_state[0]
        hidden_paths = hidden_index_path_count(root)
        if hidden_paths:
            raise ValueError(
                f"{hidden_paths} tracked path(s) use assume-unchanged or skip-worktree"
            )
        changed = collect_changes(root, base_commit, head_commit)
        if repository_state(root) != initial_state:
            raise ValueError("repository HEAD, index, or working tree changed during inspection")
    except OSError as error:
        print(f"scope-check: filesystem inspection failed ({type(error).__name__})", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as error:
        print(f"scope-check: Git inspection failed (exit {error.returncode})", file=sys.stderr)
        return 2
    except ValueError as error:
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
