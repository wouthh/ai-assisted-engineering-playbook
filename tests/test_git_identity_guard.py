from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / "scripts" / "git-identity-guard.py"
EXPECTED = "12345+synthetic-user@users.noreply.github.com"
OTHER = "someone@synthetic-mail.net"


class GuardFixture(unittest.TestCase):
    """Synthetic repository with isolated Git and guard configuration."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.repository = self.base / "repository"
        self.config = self.base / "guard.json"
        self.write_config({"expected_email": EXPECTED})
        self.env = os.environ.copy()
        for name in list(self.env):
            if name.startswith(("GIT_AUTHOR", "GIT_COMMITTER", "GIT_CONFIG", "GIT_DIR",
                                "GIT_WORK_TREE", "GIT_INDEX_FILE", "EMAIL")):
                del self.env[name]
        self.env.update({
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_IDENTITY_GUARD_CONFIG": str(self.config),
            "HOME": str(self.base),
        })
        self.git("init", "--quiet", str(self.repository), cwd=self.base)
        self.git("config", "user.name", "Synthetic User")
        self.git("config", "user.email", EXPECTED)
        self.git("config", "commit.gpgSign", "false")
        # A remote URL keeps the temporary repository guarded.
        self.git("remote", "add", "origin", "https://example.invalid/synthetic.git")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_config(self, data: object) -> None:
        self.config.write_text(json.dumps(data), encoding="utf-8")

    def git(self, *arguments: str, cwd: Path | None = None,
            env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *arguments], cwd=cwd or self.repository,
                              env=env or self.env, text=True, capture_output=True,
                              check=True)

    def guard(self, *arguments: str, env: dict[str, str] | None = None
              ) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(GUARD), *arguments],
                              cwd=self.repository, env=env or self.env, text=True,
                              capture_output=True)

    def message(self, text: str) -> str:
        path = self.base / "COMMIT_EDITMSG"
        path.write_text(text, encoding="utf-8")
        return str(path)

    def assert_refused(self, result: subprocess.CompletedProcess[str], reason: str) -> None:
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("refusing this operation", result.stderr)
        self.assertIn(reason, result.stderr)


class HelpTests(unittest.TestCase):
    def test_help_needs_no_repository_or_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(GUARD), "--help"], cwd=directory, text=True,
                capture_output=True,
                env={**os.environ, "GIT_IDENTITY_GUARD_CONFIG": "/nonexistent"})
        self.assertEqual(result.returncode, 0)
        self.assertIn("--commit-msg FILE", result.stdout)


class IdentityTests(GuardFixture):
    def test_configured_identity_passes(self) -> None:
        result = self.guard()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_configured_email_is_refused(self) -> None:
        self.git("config", "user.email", OTHER)
        self.assert_refused(self.guard(), "user.email email")

    def test_wrong_effective_committer_is_refused(self) -> None:
        env = {**self.env, "GIT_COMMITTER_EMAIL": OTHER}
        self.assert_refused(self.guard(env=env), "committer email")

    def test_missing_configuration_is_refused(self) -> None:
        self.config.unlink()
        self.assert_refused(self.guard(), "missing or invalid")

    def test_invalid_expected_email_is_refused(self) -> None:
        self.write_config({"expected_email": "not-an-address"})
        self.assert_refused(self.guard(), "valid expected_email")

    def test_cherry_pick_source_author_is_checked(self) -> None:
        env = {**self.env, "GIT_AUTHOR_EMAIL": OTHER}
        self.git("commit", "--quiet", "--allow-empty", "-m", "synthetic", env=env)
        source = self.git("rev-parse", "HEAD").stdout.strip()
        git_dir = Path(self.git("rev-parse", "--absolute-git-dir").stdout.strip())
        (git_dir / "CHERRY_PICK_HEAD").write_text(source + "\n", encoding="utf-8")
        self.assert_refused(self.guard(), "cherry-pick source author")


class MessageTests(GuardFixture):
    def test_unlisted_message_email_is_refused(self) -> None:
        path = self.message(f"Add feature\n\nCo-authored-by: Synthetic <{OTHER}>\n")
        self.assert_refused(self.guard("--commit-msg", path), "line 3")

    def test_allowlisted_message_emails_pass(self) -> None:
        self.write_config({"expected_email": EXPECTED,
                           "allowed_message_emails": ["bot@synthetic-mail.net"]})
        path = self.message(
            "Add feature\n\n"
            f"Signed-off-by: Synthetic User <{EXPECTED}>\n"
            "Co-authored-by: Other <67890+other-user@users.noreply.github.com>\n"
            "Co-authored-by: Bot <bot@synthetic-mail.net>\n"
            "Contact: docs@example.com, sample@service.invalid\n")
        result = self.guard("--commit-msg", path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_comments_and_scissors_content_are_ignored(self) -> None:
        path = self.message(
            "Add feature\n"
            f"# Please enter the commit message {OTHER}\n"
            "# ------------------------ >8 ------------------------\n"
            f"diff mentions {OTHER}\n")
        result = self.guard("--commit-msg", path, "message")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_identity_is_also_checked_in_message_mode(self) -> None:
        self.git("config", "user.email", OTHER)
        path = self.message("Add feature\n")
        self.assert_refused(self.guard("--commit-msg", path), "user.email email")

    def test_configured_hook_blocks_commit(self) -> None:
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(GUARD))} --commit-msg"
        self.git("config", "hook.identity-guard.command", command)
        self.git("config", "hook.identity-guard.event", "commit-msg")
        refused = subprocess.run(
            ["git", "commit", "--allow-empty", "-m", "Add feature",
             "-m", f"Co-authored-by: Synthetic <{OTHER}>"],
            cwd=self.repository, env=self.env, text=True, capture_output=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("not on the allowlist", refused.stderr)
        self.git("commit", "--quiet", "--allow-empty", "-m", "Add feature")
        self.assertEqual(self.git("rev-list", "--count", "HEAD").stdout.strip(), "1")


class DisposableRepositoryTests(GuardFixture):
    def test_temporary_repository_without_remote_url_is_exempt(self) -> None:
        if not str(self.base.resolve()).startswith(("/tmp/", "/var/tmp/")):
            self.skipTest("temporary directory is not under /tmp or /var/tmp")
        self.git("remote", "remove", "origin")
        self.git("config", "user.email", OTHER)
        self.config.unlink()
        path = self.message(f"Co-authored-by: Synthetic <{OTHER}>\n")
        result = self.guard("--commit-msg", path)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
