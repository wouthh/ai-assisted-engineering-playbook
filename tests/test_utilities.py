from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
GIT_BASE = [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "core.fsmonitor=false",
]


def git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
    environment["GIT_CONFIG_COUNT"] = "0"
    for name in (
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ):
        environment.pop(name, None)
    return environment


def raw_git(*arguments: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [*GIT_BASE, *arguments],
        check=True,
        env=git_environment(),
        capture_output=True,
    )


def run(
    *arguments: str,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(arguments, cwd=cwd, env=env, text=True, capture_output=True)


def git_output(repository: Path, *arguments: str) -> str:
    environment = git_environment()
    environment.update(
        {
            "GIT_AUTHOR_NAME": "Synthetic Author",
            "GIT_AUTHOR_EMAIL": "author@example.invalid",
            "GIT_COMMITTER_NAME": "Synthetic Author",
            "GIT_COMMITTER_EMAIL": "author@example.invalid",
        }
    )
    result = subprocess.run(
        [*GIT_BASE, "-C", str(repository), *arguments],
        check=True,
        env=environment,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def git(repository: Path, *arguments: str) -> None:
    git_output(repository, *arguments)


class RepositoryFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.remote = self.root / "remote.git"
        self.repository = self.root / "work"
        raw_git("init", "--bare", str(self.remote))
        raw_git("init", "-b", "main", str(self.repository))
        (self.repository / "README.md").write_text("# Synthetic repository\n", encoding="utf-8")
        git(self.repository, "add", "README.md")
        git(self.repository, "commit", "-m", "initial synthetic commit")
        git(self.repository, "remote", "add", "origin", str(self.remote))
        git(self.repository, "push", "-u", "origin", "main")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def add_synthetic_submodule(self) -> Path:
        source = self.root / "nested-source"
        raw_git("init", "-b", "main", str(source))
        for name in ("approved.txt", "protected.txt"):
            (source / name).write_text("original\n", encoding="utf-8")
        git(source, "add", "approved.txt", "protected.txt")
        git(source, "commit", "-m", "synthetic nested content")
        raw_git("-C", str(self.repository), "-c", "protocol.file.allow=always",
                "submodule", "add", str(source), "vendor/sample")
        git(self.repository, "commit", "-am", "add synthetic module")
        return self.repository / "vendor/sample"

    def drifting_git_environment(self, trigger: str) -> dict[str, str]:
        real_git = shutil.which("git")
        self.assertIsNotNone(real_git)
        wrapper_directory = self.root / "wrapper-bin"
        wrapper_directory.mkdir()
        wrapper = wrapper_directory / "git"
        marker = self.root / "drift-triggered"
        wrapper.write_text(
            "#!/usr/bin/env bash\n"
            "set -eu\n"
            f"real_git={shlex.quote(real_git or '')}\n"
            '"$real_git" "$@"\n'
            "status=$?\n"
            'matched=false\nrev_parse=false\nfor argument in "$@"; do\n'
            '  if [ "$argument" = "$DRIFT_TRIGGER" ]; then matched=true; fi\n'
            '  if [ "$argument" = "rev-parse" ]; then rev_parse=true; fi\n'
            "done\n"
            'if [ "$status" -eq 0 ] && [ "$matched" = true ] && [ "$rev_parse" = true ] '
            '&& [ ! -e "$DRIFT_MARKER" ]; then\n'
            '  printf "synthetic drift\\n" > "$DRIFT_REPOSITORY/drift.txt"\n'
            '  "$real_git" -C "$DRIFT_REPOSITORY" add drift.txt\n'
            '  "$real_git" -C "$DRIFT_REPOSITORY" -c user.name="Synthetic Author" '
            '-c user.email="author@example.invalid" -c commit.gpgSign=false '
            'commit -m "synthetic concurrent drift" >/dev/null\n'
            '  : > "$DRIFT_MARKER"\n'
            "fi\n"
            'exit "$status"\n',
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{wrapper_directory}:{environment['PATH']}",
                "DRIFT_TRIGGER": trigger,
                "DRIFT_MARKER": str(marker),
                "DRIFT_REPOSITORY": str(self.repository),
            }
        )
        return environment


class PreflightTests(RepositoryFixture):
    def test_submodule_byte_check_does_not_need_exported_functions(self) -> None:
        self.add_synthetic_submodule()
        real_git = shutil.which("git")
        wrapper_directory = self.root / "function-stripping-shell"
        wrapper_directory.mkdir()
        wrapper = wrapper_directory / "git"
        wrapper.write_text(
            f"#!{sys.executable}\nimport os, sys\n"
            "environment = {key: value for key, value in os.environ.items() if not key.startswith('BASH_FUNC_')}\n"
            f"os.execve({real_git!r}, [{real_git!r}, *sys.argv[1:]], environment)\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = f"{wrapper_directory}:{environment['PATH']}"
        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository), env=environment)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_cmp_does_not_block_clean_preflight(self) -> None:
        self.add_synthetic_submodule()
        wrapper_directory = self.root / "missing-cmp"
        wrapper_directory.mkdir()
        marker = self.root / "cmp-called"
        wrapper = wrapper_directory / "cmp"
        wrapper.write_text(f"#!/bin/sh\n: > {shlex.quote(str(marker))}\nexit 127\n", encoding="utf-8")
        wrapper.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = f"{wrapper_directory}:{environment['PATH']}"
        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository), env=environment)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(marker.exists())

    def test_normalized_raw_drift_at_final_state_check_is_detected(self) -> None:
        (self.repository / ".gitattributes").write_text("protected.txt ident\n", encoding="utf-8")
        path = self.repository / "protected.txt"
        path.write_bytes(b"$Id$\n")
        git(self.repository, "add", ".gitattributes", "protected.txt")
        git(self.repository, "commit", "-m", "synthetic ident configuration")
        blob = git_output(self.repository, "rev-parse", "HEAD:protected.txt")
        path.write_bytes(f"$Id: {blob} $\n".encode())
        git(self.repository, "add", "protected.txt")
        real_git = shutil.which("git")
        wrapper_directory = self.root / "late-byte-drift"
        wrapper_directory.mkdir()
        wrapper = wrapper_directory / "git"
        counter = self.root / "symbolic-ref-count"
        wrapper.write_text(
            f"#!{sys.executable}\nimport os, subprocess, sys\nfrom pathlib import Path\n"
            f"real_git = {real_git!r}\n"
            "result = subprocess.run([real_git, *sys.argv[1:]])\n"
            "if 'symbolic-ref' in sys.argv:\n"
            f"    counter = Path({str(counter)!r})\n"
            "    count = int(counter.read_text()) + 1 if counter.exists() else 1\n"
            "    counter.write_text(str(count))\n"
            "    if count == 2:\n"
            f"        Path({str(path)!r}).write_bytes(b'$Id: ' + b'0' * 40 + b' $\\n')\n"
            f"        subprocess.run([real_git, '-C', {str(self.repository)!r}, 'add', 'protected.txt'], check=True)\n"
            "sys.exit(result.returncode)\n", encoding="utf-8",
        )
        wrapper.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = f"{wrapper_directory}:{environment['PATH']}"
        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository), env=environment)
        self.assertEqual(result.returncode, 5, result.stdout + result.stderr)
        self.assertNotIn("working_tree\tclean", result.stdout)
        self.assertNotIn("0" * 40, result.stdout + result.stderr)

    def test_operation_started_during_inspection_fails_closed(self) -> None:
        submodule = self.add_synthetic_submodule()
        real_git = shutil.which("git")
        wrapper_directory = self.root / "operation-drift-bin"
        wrapper_directory.mkdir()
        wrapper = wrapper_directory / "git"
        wrapper.write_text(
            "#!/usr/bin/env bash\nset -eu\n"
            f"real_git={shlex.quote(real_git or '')}\n"
            '"$real_git" "$@"\n'
            'for argument in "$@"; do\n'
            '  if [ "$argument" = --porcelain=v1 ]; then\n'
            '    printf "%s\\n" "$OPERATION_HEAD" > "$OPERATION_MARKER"\n'
            '  fi\n'
            'done\n', encoding="utf-8",
        )
        wrapper.chmod(0o755)
        for repository in (self.repository, submodule):
            with self.subTest(repository=repository.name):
                marker = Path(git_output(repository, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"))
                environment = os.environ.copy()
                environment.update({
                    "PATH": f"{wrapper_directory}:{environment['PATH']}",
                    "OPERATION_HEAD": git_output(repository, "rev-parse", "HEAD"),
                    "OPERATION_MARKER": str(marker),
                })
                result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository), env=environment)
                self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
                self.assertNotIn("working_tree\tclean", result.stdout)
                marker.unlink()

    def test_clean_repository_passes(self) -> None:
        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("working_tree\tclean", result.stdout)

    def test_dirty_repository_fails_without_listing_content(self) -> None:
        (self.repository / "README.md").write_text("changed\n", encoding="utf-8")
        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))
        self.assertEqual(result.returncode, 5)
        self.assertIn("not clean", result.stderr)
        self.assertNotIn("changed", result.stdout + result.stderr)

    def test_configured_worktree_redirection_fails_closed(self) -> None:
        redirected = self.root / "redirected"
        raw_git("init", "-b", "main", str(redirected))
        (redirected / "README.md").write_text("redirected\n", encoding="utf-8")
        git(redirected, "add", "README.md")
        git(redirected, "commit", "-m", "redirected synthetic repository")
        git(self.repository, "config", "core.worktree", str(redirected))

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 10)
        self.assertIn("redirects the worktree", result.stderr)

    def test_head_drift_during_inspection_fails_closed(self) -> None:
        result = run(
            str(ROOT / "scripts/repo-preflight.sh"),
            str(self.repository),
            env=self.drifting_git_environment("HEAD"),
        )

        self.assertEqual(result.returncode, 11)
        self.assertIn("changed during inspection", result.stderr)

    def test_missing_grep_does_not_bypass_index_safety(self) -> None:
        git(self.repository, "update-index", "--assume-unchanged", "README.md")
        (self.repository / "README.md").write_text("concealed\n", encoding="utf-8")
        wrapper_directory = self.root / "missing-grep"
        wrapper_directory.mkdir()
        grep = wrapper_directory / "grep"
        grep.write_text("#!/usr/bin/env bash\nexit 127\n", encoding="utf-8")
        grep.chmod(0o755)
        environment = os.environ.copy()
        environment["PATH"] = f"{wrapper_directory}:{environment['PATH']}"

        result = run(
            str(ROOT / "scripts/repo-preflight.sh"),
            str(self.repository),
            env=environment,
        )

        self.assertEqual(result.returncode, 8)
        self.assertIn("assume-unchanged or skip-worktree", result.stderr)

    def test_dirty_submodule_cannot_be_hidden_by_repository_config(self) -> None:
        source = self.root / "submodule-source"
        raw_git("init", "-b", "main", str(source))
        (source / "tracked.txt").write_text("original\n", encoding="utf-8")
        git(source, "add", "tracked.txt")
        git(source, "commit", "-m", "add synthetic submodule content")
        subprocess.run(
            [
                *GIT_BASE,
                "-C",
                str(self.repository),
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(source),
                "vendor/sample",
            ],
            check=True,
            env=git_environment(),
            capture_output=True,
        )
        git(self.repository, "config", "-f", ".gitmodules", "submodule.vendor/sample.ignore", "all")
        git(self.repository, "add", ".gitmodules", "vendor/sample")
        git(self.repository, "commit", "-m", "add synthetic submodule")
        (self.repository / "vendor/sample/tracked.txt").write_text("modified\n", encoding="utf-8")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 5)
        self.assertIn("not clean", result.stderr)

    def test_status_failure_is_not_reported_as_clean(self) -> None:
        (self.repository / ".git/index").write_bytes(b"invalid")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 6)
        self.assertIn("unable to inspect", result.stderr)
        self.assertNotIn("working_tree\tclean", result.stdout)

    def test_in_progress_merge_is_not_reported_as_clean(self) -> None:
        git(self.repository, "switch", "-c", "pending")
        git(self.repository, "commit", "--allow-empty", "-m", "synthetic pending change")
        git(self.repository, "switch", "main")
        git(self.repository, "merge", "--no-ff", "--no-commit", "pending")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 7)
        self.assertIn("operation is in progress", result.stderr)
        self.assertNotIn("working_tree\tclean", result.stdout)

    def test_fixture_git_ignores_host_signing_configuration(self) -> None:
        hostile_config = self.root / "hostile-gitconfig"
        hostile_config.write_text("[commit]\n\tgpgSign = true\n", encoding="utf-8")

        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(hostile_config)}):
            git(self.repository, "commit", "--allow-empty", "-m", "unsigned synthetic commit")

    def test_assume_unchanged_path_fails_closed(self) -> None:
        git(self.repository, "update-index", "--assume-unchanged", "README.md")
        (self.repository / "README.md").write_text("concealed\n", encoding="utf-8")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 8)
        self.assertIn("assume-unchanged or skip-worktree", result.stderr)
        self.assertNotIn("README.md", result.stdout + result.stderr)

    def test_skip_worktree_path_fails_closed(self) -> None:
        git(self.repository, "update-index", "--skip-worktree", "README.md")
        (self.repository / "README.md").write_text("concealed\n", encoding="utf-8")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 8)
        self.assertIn("assume-unchanged or skip-worktree", result.stderr)
        self.assertNotIn("README.md", result.stdout + result.stderr)

    def test_in_progress_submodule_merge_is_not_reported_as_clean(self) -> None:
        source = self.root / "submodule-source"
        raw_git("init", "-b", "main", str(source))
        (source / "tracked.txt").write_text("original\n", encoding="utf-8")
        git(source, "add", "tracked.txt")
        git(source, "commit", "-m", "add synthetic submodule content")
        subprocess.run(
            [
                *GIT_BASE,
                "-C",
                str(self.repository),
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(source),
                "vendor/sample",
            ],
            check=True,
            env=git_environment(),
            capture_output=True,
        )
        git(self.repository, "add", ".gitmodules", "vendor/sample")
        git(self.repository, "commit", "-m", "add synthetic submodule")
        submodule = self.repository / "vendor/sample"
        git(submodule, "switch", "-c", "pending")
        git(submodule, "commit", "--allow-empty", "-m", "synthetic pending change")
        git(submodule, "switch", "main")
        git(submodule, "merge", "--no-ff", "--no-commit", "pending")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 7)
        self.assertIn("operation is in progress in a submodule", result.stderr)
        self.assertNotIn("working_tree\tclean", result.stdout)

    def test_relaxed_stat_configuration_cannot_hide_same_size_edit(self) -> None:
        git(self.repository, "config", "core.trustctime", "false")
        git(self.repository, "config", "core.checkStat", "minimal")
        git(self.repository, "status", "--short")
        original = (self.repository / "README.md").stat()
        (self.repository / "README.md").write_text("# Concealed repository\n", encoding="utf-8")
        os.utime(
            self.repository / "README.md",
            ns=(original.st_atime_ns, original.st_mtime_ns),
        )

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 5)
        self.assertIn("not clean", result.stderr)

    def test_case_folding_configuration_cannot_hide_distinct_file(self) -> None:
        (self.repository / "readme").write_text("tracked\n", encoding="utf-8")
        git(self.repository, "add", "readme")
        git(self.repository, "commit", "-m", "add lowercase tracked path")
        git(self.repository, "config", "core.ignoreCase", "true")
        (self.repository / "README").write_text("untracked\n", encoding="utf-8")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 5)
        self.assertIn("not clean", result.stderr)

    def test_repository_root_is_shell_escaped(self) -> None:
        escaped_repository = self.root / "work\nhead\tfake"
        self.repository.rename(escaped_repository)
        self.repository = escaped_repository

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("\nhead\tfake", result.stdout)
        self.assertIn("\\nhead\\tfake", result.stdout)

    def test_trailing_space_in_repository_root_is_preserved(self) -> None:
        clean_repository = self.root / "work"
        dirty_repository = self.root / "work "
        self.repository.rename(dirty_repository)
        self.repository = dirty_repository
        raw_git("init", "-b", "main", str(clean_repository))
        (clean_repository / "README.md").write_text("clean\n", encoding="utf-8")
        git(clean_repository, "add", "README.md")
        git(clean_repository, "commit", "-m", "initial clean commit")
        (dirty_repository / "README.md").write_text("dirty\n", encoding="utf-8")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(dirty_repository))

        self.assertEqual(result.returncode, 5)
        self.assertIn("not clean", result.stderr)

    def test_content_filter_is_rejected_without_execution(self) -> None:
        marker = self.root / "filter-executed"
        (self.repository / ".gitattributes").write_text("README.md filter=hider\n", encoding="utf-8")
        git(self.repository, "add", ".gitattributes")
        git(self.repository, "commit", "-m", "configure synthetic attributes")
        git(
            self.repository,
            "config",
            "filter.hider.clean",
            f"sh -c 'touch {marker}; cat'",
        )
        (self.repository / "README.md").write_text("changed\n", encoding="utf-8")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 9)
        self.assertIn("clean/process filters", result.stderr)
        self.assertFalse(marker.exists())

    def test_ambient_content_filter_does_not_reject_repository(self) -> None:
        global_config = self.root / "global-git-config"
        global_config.write_text(
            '[filter "ambient"]\n\tclean = false\n\tprocess = false\n',
            encoding="utf-8",
        )

        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(global_config)}):
            result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("working_tree\tclean", result.stdout)

    def test_symlink_type_change_cannot_be_hidden(self) -> None:
        link = self.repository / "link"
        link.symlink_to("synthetic-target")
        git(self.repository, "add", "link")
        git(self.repository, "commit", "-m", "add synthetic symlink")
        git(self.repository, "config", "core.symlinks", "false")
        link.unlink()
        link.write_text("synthetic-target", encoding="utf-8")

        result = run(str(ROOT / "scripts/repo-preflight.sh"), str(self.repository))

        self.assertEqual(result.returncode, 5)
        self.assertIn("not clean", result.stderr)


class ScopeTests(RepositoryFixture):
    def test_removed_gitlink_requires_inspectable_nested_deletions(self) -> None:
        self.add_synthetic_submodule()
        base = git_output(self.repository, "rev-parse", "HEAD")
        git(self.repository, "rm", "-f", "vendor/sample")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text(".gitmodules\nvendor/sample\n", encoding="utf-8")
        command = (
            sys.executable, str(ROOT / "scripts/check-change-scope.py"),
            "--repository", str(self.repository), "--base", base,
            "--allowlist", str(allowlist),
        )
        for committed in (False, True):
            if committed:
                git(self.repository, "commit", "-am", "remove synthetic module")
            result = run(*command)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("submodule checkout is unavailable", result.stderr)

    def test_smudge_driver_is_rejected_without_execution(self) -> None:
        marker = self.root / "smudge-executed"
        (self.repository / ".gitattributes").write_text("README.md filter=example\n", encoding="utf-8")
        git(self.repository, "add", ".gitattributes")
        git(self.repository, "commit", "-m", "declare synthetic filter attribute")
        git(self.repository, "config", "filter.example.smudge", f"touch {shlex.quote(str(marker))}; cat")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        commands = (
            (str(ROOT / "scripts/repo-preflight.sh"), str(self.repository)),
            (sys.executable, str(ROOT / "scripts/check-change-scope.py"),
             "--repository", str(self.repository), "--base", "HEAD", "--allowlist", str(allowlist)),
        )
        for command in commands:
            result = run(*command)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("filter", result.stderr)
            self.assertFalse(marker.exists())

    def test_worktree_gitlink_reversal_cannot_hide_staged_nested_path(self) -> None:
        submodule = self.add_synthetic_submodule()
        original_nested = git_output(submodule, "rev-parse", "HEAD")
        (submodule / "protected.txt").write_text("staged change\n", encoding="utf-8")
        git(submodule, "commit", "-am", "change protected nested content")
        git(self.repository, "add", "vendor/sample")
        git(submodule, "switch", "--detach", original_nested)
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("vendor/sample\n", encoding="utf-8")
        result = run(
            sys.executable, str(ROOT / "scripts/check-change-scope.py"),
            "--repository", str(self.repository), "--base", "HEAD",
            "--allowlist", str(allowlist),
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('unexpected\t"vendor/sample/protected.txt"', result.stdout)

    def test_staged_gitlink_reversal_cannot_hide_committed_nested_path(self) -> None:
        submodule = self.add_synthetic_submodule()
        base = git_output(self.repository, "rev-parse", "HEAD")
        original_nested = git_output(submodule, "rev-parse", "HEAD")
        (submodule / "protected.txt").write_text("committed change\n", encoding="utf-8")
        git(submodule, "commit", "-am", "change protected nested content")
        git(self.repository, "commit", "-am", "advance committed gitlink")
        git(submodule, "switch", "--detach", original_nested)
        git(self.repository, "add", "vendor/sample")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("vendor/sample\n", encoding="utf-8")
        result = run(
            sys.executable, str(ROOT / "scripts/check-change-scope.py"),
            "--repository", str(self.repository), "--base", base,
            "--allowlist", str(allowlist),
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('unexpected\t"vendor/sample/protected.txt"', result.stdout)

    def test_ident_expansion_is_checked_without_cleaning_away_edits(self) -> None:
        submodule = self.add_synthetic_submodule()
        for repository in (self.repository, submodule):
            (repository / ".gitattributes").write_text("protected.txt ident\n", encoding="utf-8")
            (repository / "protected.txt").write_bytes(b"$Id$\n")
            git(repository, "add", ".gitattributes", "protected.txt")
            git(repository, "commit", "-m", "declare synthetic ident expansion")
            blob = git_output(repository, "rev-parse", "HEAD:protected.txt")
            (repository / "protected.txt").write_bytes(f"$Id: {blob} $\n".encode())
            git(repository, "add", "protected.txt")
        git(self.repository, "commit", "-am", "advance expanded module")
        for repository in (submodule, self.repository):
            git(repository, "status", "--short")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        commands = (
            (str(ROOT / "scripts/repo-preflight.sh"), str(self.repository)),
            (sys.executable, str(ROOT / "scripts/check-change-scope.py"),
             "--repository", str(self.repository), "--base", "HEAD", "--allowlist", str(allowlist)),
        )
        for command in commands:
            result = run(*command)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for repository in (self.repository, submodule):
            (repository / "protected.txt").write_bytes(b"$Id: " + b"a" * 40 + b" $\n")
            git(repository, "add", "protected.txt")
        for repository in (submodule, self.repository):
            git(repository, "status", "--short")
        for command in commands:
            result = run(*command)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn("a" * 40, result.stdout + result.stderr)

    def test_ambient_git_exec_path_cannot_execute_a_submodule_helper(self) -> None:
        helpers = self.root / "untrusted-helpers"
        helpers.mkdir()
        marker = self.root / "helper-executed"
        helper = helpers / "git-submodule"
        helper.write_text(
            "#!/bin/sh\n" + f": > {shlex.quote(str(marker))}\nexit 0\n", encoding="utf-8"
        )
        helper.chmod(0o755)
        environment = os.environ.copy()
        environment["GIT_EXEC_PATH"] = str(helpers)
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        commands = (
            (str(ROOT / "scripts/repo-preflight.sh"), str(self.repository)),
            (sys.executable, str(ROOT / "scripts/check-change-scope.py"),
             "--repository", str(self.repository), "--base", "HEAD", "--allowlist", str(allowlist)),
        )
        for command in commands:
            result = run(*command, env=environment)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse(marker.exists())

    def test_diverged_submodule_uses_superproject_merge_base(self) -> None:
        submodule = self.add_synthetic_submodule()
        root_ancestor = git_output(self.repository, "rev-parse", "HEAD")
        nested_ancestor = git_output(submodule, "rev-parse", "HEAD")
        git(self.repository, "switch", "-c", "base-side")
        (submodule / "protected.txt").write_text("same final content\n", encoding="utf-8")
        git(submodule, "commit", "-am", "base-side nested change")
        base_nested_tree = git_output(submodule, "rev-parse", "HEAD^{tree}")
        git(self.repository, "commit", "-am", "advance base-side gitlink")
        git(self.repository, "switch", "-c", "feature", root_ancestor)
        git(submodule, "switch", "-c", "feature", nested_ancestor)
        (submodule / "protected.txt").write_text("same final content\n", encoding="utf-8")
        git(submodule, "commit", "-am", "feature-side nested change")
        self.assertEqual(git_output(submodule, "rev-parse", "HEAD^{tree}"), base_nested_tree)
        git(self.repository, "commit", "-am", "advance feature gitlink")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("vendor/sample\n", encoding="utf-8")
        result = run(
            sys.executable, str(ROOT / "scripts/check-change-scope.py"),
            "--repository", str(self.repository), "--base", "base-side",
            "--allowlist", str(allowlist),
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('unexpected\t"vendor/sample/protected.txt"', result.stdout)

    def test_normalized_worktree_edit_still_requires_scope_approval(self) -> None:
        submodule = self.add_synthetic_submodule()
        for repository in (self.repository, submodule):
            (repository / ".gitattributes").write_text("*.txt text\n", encoding="utf-8")
            (repository / "protected.txt").write_bytes(b"original\n")
            git(repository, "add", ".gitattributes", "protected.txt")
            git(repository, "commit", "-m", "declare synthetic text normalization")
        git(self.repository, "commit", "-am", "advance normalized module")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        for repository in (self.repository, submodule):
            (repository / "protected.txt").write_bytes(b"original\r\n")
        result = run(
            sys.executable, str(ROOT / "scripts/check-change-scope.py"),
            "--repository", str(self.repository), "--base", "HEAD",
            "--allowlist", str(allowlist),
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for path in ("protected.txt", "vendor/sample/protected.txt"):
            self.assertIn(f'unexpected\t"{path}"', result.stdout)

    def test_uninitialized_submodule_fails_both_tools(self) -> None:
        submodule = self.add_synthetic_submodule()
        (submodule / ".git").unlink()
        (submodule / "unexpected.txt").write_text("synthetic local work\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        commands = (
            (str(ROOT / "scripts/repo-preflight.sh"), str(self.repository)),
            (sys.executable, str(ROOT / "scripts/check-change-scope.py"),
             "--repository", str(self.repository), "--base", "HEAD", "--allowlist", str(allowlist)),
        )
        for command in commands:
            result = run(*command)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not initialized", result.stderr)
            self.assertNotIn("synthetic local work", result.stdout + result.stderr)

    def test_submodule_files_require_individual_scope_approval(self) -> None:
        submodule = self.add_synthetic_submodule()
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("vendor/sample/approved.txt\n", encoding="utf-8")
        command = (
            sys.executable, str(ROOT / "scripts/check-change-scope.py"),
            "--repository", str(self.repository), "--base", "HEAD", "--allowlist", str(allowlist),
        )
        (submodule / "approved.txt").write_text("approved change\n", encoding="utf-8")
        result = run(*command)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('allowed\t"vendor/sample/approved.txt"', result.stdout)
        git(submodule, "add", "approved.txt")
        self.assertEqual(run(*command).returncode, 0)
        git(submodule, "commit", "-m", "approved nested change")
        allowlist.write_text("vendor/sample\nvendor/sample/approved.txt\n", encoding="utf-8")
        result = run(*command)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for name in ("protected.txt", "untracked.txt"):
            (submodule / name).write_text("outside approved scope\n", encoding="utf-8")
        result = run(*command)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for name in ("protected.txt", "untracked.txt"):
            self.assertIn(f'unexpected\t"vendor/sample/{name}"', result.stdout)

    def test_dirty_and_untracked_content_drift_fails_closed(self) -> None:
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\nnew.txt\n", encoding="utf-8")
        real_git = shutil.which("git")
        wrapper_directory = self.root / "content-drift-bin"
        wrapper_directory.mkdir()
        wrapper = wrapper_directory / "git"
        wrapper.write_text(
            "#!/usr/bin/env bash\nset -eu\n"
            f"real_git={shlex.quote(real_git or '')}\n"
            '"$real_git" "$@"\n'
            'is_diff=false\nfor argument in "$@"; do\n'
            '  if [ "$argument" = diff ]; then is_diff=true; fi\n'
            'done\n'
            'for argument in "$@"; do\n'
            '  if [ "$is_diff" = true ] && [ "$argument" = "--cached" ] && [ ! -e "$DRIFT_MARKER" ]; then\n'
            '    printf "changed again\\n" > "$DRIFT_FILE"\n'
            '    : > "$DRIFT_MARKER"\n'
            '  fi\n'
            'done\n', encoding="utf-8",
        )
        wrapper.chmod(0o755)
        for name in ("README.md", "new.txt"):
            with self.subTest(name=name):
                path = self.repository / name
                path.write_text("already dirty\n", encoding="utf-8")
                environment = os.environ.copy()
                environment.update({
                    "PATH": f"{wrapper_directory}:{environment['PATH']}",
                    "DRIFT_FILE": str(path),
                    "DRIFT_MARKER": str(self.root / f"marker-{name}"),
                })
                result = run(
                    sys.executable, str(ROOT / "scripts/check-change-scope.py"),
                    "--repository", str(self.repository), "--base", "main",
                    "--allowlist", str(allowlist), env=environment,
                )
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("changed during inspection", result.stderr)
                self.assertNotIn("changed again", result.stdout + result.stderr)

    def test_submodule_worktree_redirection_is_rejected_by_both_tools(self) -> None:
        source = self.root / "module-source"
        raw_git("init", "-b", "main", str(source))
        (source / "tracked.txt").write_text("original\n", encoding="utf-8")
        git(source, "add", "tracked.txt")
        git(source, "commit", "-m", "synthetic module")
        raw_git("-C", str(self.repository), "-c", "protocol.file.allow=always",
                "submodule", "add", str(source), "vendor/sample")
        git(self.repository, "commit", "-am", "add synthetic module")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        commands = (
            (str(ROOT / "scripts/repo-preflight.sh"), str(self.repository)),
            (sys.executable, str(ROOT / "scripts/check-change-scope.py"),
             "--repository", str(self.repository), "--base", "HEAD",
             "--allowlist", str(allowlist)),
        )
        # Git's normal relative core.worktree entry remains supported.
        for command in commands:
            result = run(*command)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        submodule = self.repository / "vendor/sample"
        redirected = self.root / "redirected-module"
        redirected.mkdir()
        (redirected / "tracked.txt").write_text("original\n", encoding="utf-8")
        git(submodule, "config", "core.worktree", str(redirected))
        (submodule / "tracked.txt").write_text("uninspected change\n", encoding="utf-8")
        for command in commands:
            result = run(*command)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("working_tree\tclean", result.stdout)
            self.assertNotIn("changed path(s) allowed", result.stdout)

    def test_allowed_committed_change_passes(self) -> None:
        git(self.repository, "switch", "-c", "feature")
        (self.repository / "README.md").write_text("# Updated synthetic repository\n", encoding="utf-8")
        git(self.repository, "add", "README.md")
        git(self.repository, "commit", "-m", "update synthetic documentation")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('allowed\t"README.md"', result.stdout)

    def test_untracked_path_outside_allowlist_fails(self) -> None:
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        (self.repository / "unexpected.txt").write_text("synthetic\n", encoding="utf-8")
        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"unexpected.txt"', result.stdout)

    def test_configured_worktree_redirection_fails_closed(self) -> None:
        redirected = self.root / "redirected"
        raw_git("init", "-b", "main", str(redirected))
        (redirected / "README.md").write_text("redirected\n", encoding="utf-8")
        git(redirected, "add", "README.md")
        git(redirected, "commit", "-m", "redirected synthetic repository")
        git(self.repository, "config", "core.worktree", str(redirected))
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("redirects the worktree", result.stderr)

    def test_head_drift_during_inspection_fails_closed(self) -> None:
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
            env=self.drifting_git_environment("HEAD^{commit}"),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("changed during inspection", result.stderr)

    def test_empty_base_fails_closed(self) -> None:
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base=",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("base must name a commit", result.stderr)

    def test_option_like_base_fails_without_creating_output(self) -> None:
        git(self.repository, "switch", "-c", "feature")
        (self.repository / "protected.txt").write_text("synthetic\n", encoding="utf-8")
        git(self.repository, "add", "protected.txt")
        git(self.repository, "commit", "-m", "add protected path")
        output = self.root / "unexpected-output"
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            f"--base=--output={output}",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("base must name a commit", result.stderr)
        self.assertFalse(output.exists())

    def test_relaxed_stat_configuration_cannot_hide_same_size_edit(self) -> None:
        (self.repository / "protected.txt").write_text("original\n", encoding="utf-8")
        git(self.repository, "add", "protected.txt")
        git(self.repository, "commit", "-m", "add protected path")
        git(self.repository, "config", "core.trustctime", "false")
        git(self.repository, "config", "core.checkStat", "minimal")
        git(self.repository, "status", "--short")
        original = (self.repository / "protected.txt").stat()
        (self.repository / "protected.txt").write_text("modified\n", encoding="utf-8")
        os.utime(
            self.repository / "protected.txt",
            ns=(original.st_atime_ns, original.st_mtime_ns),
        )
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"protected.txt"', result.stdout)

    def test_case_folding_configuration_cannot_hide_distinct_file(self) -> None:
        (self.repository / "readme").write_text("tracked\n", encoding="utf-8")
        git(self.repository, "add", "readme")
        git(self.repository, "commit", "-m", "add lowercase tracked path")
        git(self.repository, "config", "core.ignoreCase", "true")
        (self.repository / "README").write_text("untracked\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"README"', result.stdout)

    def test_trailing_space_in_repository_root_is_preserved(self) -> None:
        clean_repository = self.root / "work"
        dirty_repository = self.root / "work "
        self.repository.rename(dirty_repository)
        self.repository = dirty_repository
        raw_git("init", "-b", "main", str(clean_repository))
        (clean_repository / "README.md").write_text("clean\n", encoding="utf-8")
        git(clean_repository, "add", "README.md")
        git(clean_repository, "commit", "-m", "initial clean commit")
        (dirty_repository / "unexpected.txt").write_text("synthetic\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(dirty_repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"unexpected.txt"', result.stdout)

    def test_content_filter_is_rejected_without_execution(self) -> None:
        marker = self.root / "filter-executed"
        (self.repository / ".gitattributes").write_text("README.md filter=hider\n", encoding="utf-8")
        git(self.repository, "add", ".gitattributes")
        git(self.repository, "commit", "-m", "configure synthetic attributes")
        git(
            self.repository,
            "config",
            "filter.hider.clean",
            f"sh -c 'touch {marker}; cat'",
        )
        (self.repository / "README.md").write_text("changed\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("clean/process filters", result.stderr)
        self.assertFalse(marker.exists())

    def test_ambient_content_filter_does_not_reject_repository(self) -> None:
        global_config = self.root / "global-git-config"
        global_config.write_text(
            '[filter "ambient"]\n\tclean = false\n\tprocess = false\n',
            encoding="utf-8",
        )
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(global_config)}):
            result = run(
                sys.executable,
                str(ROOT / "scripts/check-change-scope.py"),
                "--repository",
                str(self.repository),
                "--base",
                "main",
                "--allowlist",
                str(allowlist),
            )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_allowlist_preserves_leading_and_trailing_whitespace(self) -> None:
        spaced_paths = {" leading.txt", "trailing.txt "}
        unspaced_paths = {"leading.txt", "trailing.txt"}
        for path in spaced_paths | unspaced_paths:
            (self.repository / path).write_text("synthetic\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text(" leading.txt\ntrailing.txt \n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        for path in spaced_paths:
            self.assertIn(f'allowed\t"{path}"', result.stdout)
        for path in unspaced_paths:
            self.assertIn(f'unexpected\t"{path}"', result.stdout)

    def test_allowlist_json_encodes_literal_leading_hash(self) -> None:
        (self.repository / "#approved.txt").write_text("synthetic\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text(
            f"# comment\n{json.dumps('#approved.txt')}\n",
            encoding="utf-8",
        )

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('allowed\t"#approved.txt"', result.stdout)

    def test_symlink_type_change_cannot_be_hidden(self) -> None:
        link = self.repository / "link"
        link.symlink_to("synthetic-target")
        git(self.repository, "add", "link")
        git(self.repository, "commit", "-m", "add synthetic symlink")
        git(self.repository, "config", "core.symlinks", "false")
        link.unlink()
        link.write_text("synthetic-target", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"link"', result.stdout)

    def test_staged_path_outside_allowlist_fails(self) -> None:
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")
        (self.repository / "staged.txt").write_text("synthetic\n", encoding="utf-8")
        git(self.repository, "add", "staged.txt")
        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"staged.txt"', result.stdout)

    def test_rename_checks_source_and_destination(self) -> None:
        (self.repository / "protected.txt").write_text("synthetic\n", encoding="utf-8")
        git(self.repository, "add", "protected.txt")
        git(self.repository, "commit", "-m", "add protected path")
        git(self.repository, "switch", "-c", "feature")
        git(self.repository, "mv", "protected.txt", "approved.txt")
        git(self.repository, "commit", "-m", "rename protected path")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("approved.txt\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"protected.txt"', result.stdout)

    def test_single_star_does_not_cross_directory_boundary(self) -> None:
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("docs/*.md\n", encoding="utf-8")
        nested = self.repository / "docs/private/nested.md"
        nested.parent.mkdir(parents=True)
        nested.write_text("synthetic\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"docs/private/nested.md"', result.stdout)

    def test_double_star_explicitly_allows_recursive_paths(self) -> None:
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("docs/**/*.md\n", encoding="utf-8")
        nested = self.repository / "docs/private/nested.md"
        nested.parent.mkdir(parents=True)
        nested.write_text("synthetic\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('allowed\t"docs/private/nested.md"', result.stdout)

    def test_submodule_ignore_cannot_hide_scope_change(self) -> None:
        source = self.root / "submodule-source"
        raw_git("init", "-b", "main", str(source))
        (source / "tracked.txt").write_text("original\n", encoding="utf-8")
        git(source, "add", "tracked.txt")
        git(source, "commit", "-m", "add synthetic submodule content")
        subprocess.run(
            [
                *GIT_BASE,
                "-C",
                str(self.repository),
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(source),
                "vendor/sample",
            ],
            check=True,
            env=git_environment(),
            capture_output=True,
        )
        git(self.repository, "config", "-f", ".gitmodules", "submodule.vendor/sample.ignore", "all")
        git(self.repository, "add", ".gitmodules", "vendor/sample")
        git(self.repository, "commit", "-m", "add synthetic submodule")
        (self.repository / "vendor/sample/tracked.txt").write_text("modified\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"vendor/sample/tracked.txt"', result.stdout)

    def test_submodule_index_flag_cannot_hide_scope_change(self) -> None:
        source = self.root / "submodule-source"
        raw_git("init", "-b", "main", str(source))
        (source / "tracked.txt").write_text("original\n", encoding="utf-8")
        git(source, "add", "tracked.txt")
        git(source, "commit", "-m", "add synthetic submodule content")
        subprocess.run(
            [
                *GIT_BASE,
                "-C",
                str(self.repository),
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                str(source),
                "vendor/sample",
            ],
            check=True,
            env=git_environment(),
            capture_output=True,
        )
        git(self.repository, "add", ".gitmodules", "vendor/sample")
        git(self.repository, "commit", "-m", "add synthetic submodule")
        submodule = self.repository / "vendor/sample"
        git(submodule, "update-index", "--assume-unchanged", "tracked.txt")
        (submodule / "tracked.txt").write_text("concealed\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("assume-unchanged or skip-worktree", result.stderr)

    def test_nested_repository_argument_still_scans_repository_root(self) -> None:
        nested = self.repository / "sub"
        nested.mkdir()
        (nested / "inside.txt").write_text("synthetic\n", encoding="utf-8")
        (self.repository / "outside.txt").write_text("synthetic\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("sub/inside.txt\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(nested),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('allowed\t"sub/inside.txt"', result.stdout)
        self.assertIn('unexpected\t"outside.txt"', result.stdout)

    def test_index_visibility_flags_fail_closed(self) -> None:
        (self.repository / "protected.txt").write_text("original\n", encoding="utf-8")
        git(self.repository, "add", "protected.txt")
        git(self.repository, "commit", "-m", "add protected path")
        git(self.repository, "update-index", "--assume-unchanged", "protected.txt")
        (self.repository / "protected.txt").write_text("modified\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("assume-unchanged or skip-worktree", result.stderr)

    def test_ambient_repository_environment_cannot_redirect_scope_check(self) -> None:
        other = self.root / "other"
        raw_git("init", "-b", "main", str(other))
        (other / "README.md").write_text("# Other synthetic repository\n", encoding="utf-8")
        git(other, "add", "README.md")
        git(other, "commit", "-m", "initial other commit")
        (self.repository / "unexpected.txt").write_text("synthetic\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        with mock.patch.dict(
            os.environ,
            {"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other)},
        ):
            result = run(
                sys.executable,
                str(ROOT / "scripts/check-change-scope.py"),
                "--repository",
                str(self.repository),
                "--base",
                "main",
                "--allowlist",
                str(allowlist),
            )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"unexpected.txt"', result.stdout)

    def test_replacement_object_cannot_hide_committed_change(self) -> None:
        git(self.repository, "switch", "-c", "feature")
        (self.repository / "protected.txt").write_text("synthetic\n", encoding="utf-8")
        git(self.repository, "add", "protected.txt")
        git(self.repository, "commit", "-m", "add protected path")
        feature_head = git_output(self.repository, "rev-parse", "HEAD")
        base = git_output(self.repository, "rev-parse", "main")
        base_tree = git_output(self.repository, "rev-parse", "main^{tree}")
        replacement = git_output(
            self.repository,
            "commit-tree",
            base_tree,
            "-p",
            base,
            "-m",
            "synthetic replacement",
        )
        git(self.repository, "replace", feature_head, replacement)
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"protected.txt"', result.stdout)

    def test_graft_file_cannot_hide_committed_change(self) -> None:
        git(self.repository, "switch", "-c", "feature")
        (self.repository / "protected.txt").write_text("synthetic\n", encoding="utf-8")
        git(self.repository, "add", "protected.txt")
        git(self.repository, "commit", "-m", "add protected path")
        feature_head = git_output(self.repository, "rev-parse", "HEAD")
        base = git_output(self.repository, "rev-parse", "main")
        (self.repository / ".git/info/grafts").write_text(
            f"{base} {feature_head}\n",
            encoding="ascii",
        )
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"protected.txt"', result.stdout)
        self.assertNotIn("graft", result.stderr.lower())

    def test_reported_paths_escape_control_characters(self) -> None:
        strange = self.repository / "unsafe\nallowed\tapproved.py"
        strange.write_text("synthetic\n", encoding="utf-8")
        allowlist = self.root / "allowlist.txt"
        allowlist.write_text("README.md\n", encoding="utf-8")

        result = run(
            sys.executable,
            str(ROOT / "scripts/check-change-scope.py"),
            "--repository",
            str(self.repository),
            "--base",
            "main",
            "--allowlist",
            str(allowlist),
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected\t"unsafe\\nallowed\\tapproved.py"', result.stdout)
        self.assertNotIn("\nallowed\tapproved.py", result.stdout)


class RedactionTests(unittest.TestCase):
    def test_invalid_pattern_content_is_not_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("invalid\tSECRET(unclosed\n", encoding="utf-8")
            report.write_text("synthetic\n", encoding="utf-8")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("invalid regular expression row 1", result.stderr)
            self.assertNotIn("SECRET", result.stdout + result.stderr)

    def test_unreadable_pattern_path_is_escaped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "missing\nredaction-check: 1 file(s) clear"
            report = root / "report.txt"
            report.write_text("synthetic\n", encoding="utf-8")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 2)
            self.assertEqual(len(result.stderr.splitlines()), 1)
            self.assertIn("\\nredaction-check", result.stderr)
            self.assertNotIn("\nredaction-check", result.stderr)

    def test_finding_is_reported_without_matched_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("synthetic-token\tSYNTHETIC_TOKEN_[A-Z]+\n", encoding="utf-8")
            report.write_text("value=SYNTHETIC_TOKEN_EXAMPLE\n", encoding="utf-8")
            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("synthetic-token", result.stdout)
            self.assertNotIn("SYNTHETIC_TOKEN_EXAMPLE", result.stdout + result.stderr)

    def test_clear_report_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("synthetic-token\tSYNTHETIC_TOKEN_[A-Z]+\n", encoding="utf-8")
            report.write_text("No synthetic credential material.\n", encoding="utf-8")
            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_multiline_expression_matches_complete_report(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("synthetic-block\tBEGIN[\\s\\S]*END\n", encoding="utf-8")
            report.write_text("prefix\nBEGIN\nmiddle\nEND\n", encoding="utf-8")
            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("line:2", result.stdout)
            self.assertNotIn("middle", result.stdout + result.stderr)

    def test_crlf_expression_matches_original_newlines(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("synthetic-crlf\tBEGIN\\r\\nEND\n", encoding="utf-8")
            report.write_bytes(b"prefix\r\nBEGIN\r\nEND\r\n")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("synthetic-crlf", result.stdout)
            self.assertNotIn("BEGIN", result.stdout + result.stderr)

    def test_lone_carriage_return_counts_as_line_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("synthetic-token\tSECRET\n", encoding="utf-8")
            report.write_bytes(b"first\rsecond SECRET\r")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("line:2", result.stdout)

    def test_line_anchors_apply_to_each_report_line(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("anchored\t^SECRET=\n", encoding="utf-8")
            report.write_text("first\nSECRET=synthetic\n", encoding="utf-8")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("anchored", result.stdout)
            self.assertIn("line:2", result.stdout)
            self.assertNotIn("SECRET=synthetic", result.stdout + result.stderr)

    def test_line_start_anchor_recognizes_lone_carriage_return(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("anchored\t^SECRET=\n", encoding="utf-8")
            report.write_bytes(b"first\rSECRET=synthetic\r")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("line:2", result.stdout)
            self.assertNotIn("SECRET=synthetic", result.stdout + result.stderr)

    def test_line_end_anchor_recognizes_crlf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("anchored\tSECRET$\n", encoding="utf-8")
            report.write_bytes(b"first\r\nSECRET\r\n")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("line:2", result.stdout)

    def test_anchor_text_inside_regex_comment_is_not_transformed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text(
                "commented-anchor\t(?# mention $ and \\) here)SECRET\n",
                encoding="utf-8",
            )
            report.write_text("SECRET\n", encoding="utf-8")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("commented-anchor", result.stdout)

    def test_anchor_text_inside_character_class_is_not_transformed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "report.txt"
            patterns.write_text("class-anchors\t[^^][$]\n", encoding="utf-8")
            report.write_text("x$\n", encoding="utf-8")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("class-anchors", result.stdout)

    def test_unreadable_report_path_is_escaped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            patterns = root / "patterns.tsv"
            report = root / "missing\nredaction-check: 1 file(s) clear"
            patterns.write_text("synthetic-token\tSECRET\n", encoding="utf-8")

            result = run(
                sys.executable,
                str(ROOT / "scripts/check-report-redaction.py"),
                "--patterns",
                str(patterns),
                str(report),
            )

            self.assertEqual(result.returncode, 2)
            self.assertEqual(len(result.stderr.splitlines()), 1)
            self.assertIn("\\nredaction-check", result.stderr)
            self.assertNotIn("\nredaction-check", result.stderr)


if __name__ == "__main__":
    unittest.main()
