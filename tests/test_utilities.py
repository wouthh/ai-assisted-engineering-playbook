from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(*arguments: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(arguments, cwd=cwd, text=True, capture_output=True)


def git(repository: Path, *arguments: str) -> None:
    environment = os.environ.copy()
    environment.update(
        {
            "GIT_AUTHOR_NAME": "Synthetic Author",
            "GIT_AUTHOR_EMAIL": "author@example.invalid",
            "GIT_COMMITTER_NAME": "Synthetic Author",
            "GIT_COMMITTER_EMAIL": "author@example.invalid",
        }
    )
    subprocess.run(["git", "-C", str(repository), *arguments], check=True, env=environment, capture_output=True)


class RepositoryFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.remote = self.root / "remote.git"
        self.repository = self.root / "work"
        subprocess.run(["git", "init", "--bare", str(self.remote)], check=True, capture_output=True)
        subprocess.run(["git", "init", "-b", "main", str(self.repository)], check=True, capture_output=True)
        (self.repository / "README.md").write_text("# Synthetic repository\n", encoding="utf-8")
        git(self.repository, "add", "README.md")
        git(self.repository, "commit", "-m", "initial synthetic commit")
        git(self.repository, "remote", "add", "origin", str(self.remote))
        git(self.repository, "push", "-u", "origin", "main")

    def tearDown(self) -> None:
        self.temporary.cleanup()


class PreflightTests(RepositoryFixture):
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


class ScopeTests(RepositoryFixture):
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
        self.assertIn("allowed\tREADME.md", result.stdout)

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
        self.assertIn("unexpected\tunexpected.txt", result.stdout)

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
        self.assertIn("unexpected\tstaged.txt", result.stdout)


class RedactionTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
