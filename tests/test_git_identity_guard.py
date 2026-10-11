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
ZERO = "0" * 40


def configured_hooks_supported(env: dict[str, str], repository: Path) -> bool:
    """Older Git accepts hook.<name>.* keys but silently ignores them."""
    subprocess.run(["git", "config", "hook.feature-probe.command", "true"],
                   cwd=repository, env=env, check=True)
    subprocess.run(["git", "config", "hook.feature-probe.event", "pre-commit"],
                   cwd=repository, env=env, check=True)
    try:
        listed = subprocess.run(["git", "hook", "list", "pre-commit"], cwd=repository,
                                env=env, text=True, capture_output=True)
        return listed.returncode == 0 and "feature-probe" in listed.stdout
    finally:
        subprocess.run(["git", "config", "--remove-section", "hook.feature-probe"],
                       cwd=repository, env=env, check=True)


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

    def guard(self, *arguments: str, env: dict[str, str] | None = None,
              stdin: str = "") -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(GUARD), *arguments],
                              cwd=self.repository, env=env or self.env, text=True,
                              capture_output=True, input=stdin)

    def require_configured_hooks(self) -> None:
        if not configured_hooks_supported(self.env, self.repository):
            self.skipTest("this Git release ignores configured hooks")

    def commit(self, message: str, env: dict[str, str] | None = None) -> str:
        self.git("commit", "--quiet", "--allow-empty", "-m", message, env=env)
        return self.git("rev-parse", "HEAD").stdout.strip()

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

    def test_inherited_trace_destinations_are_not_written(self) -> None:
        trace = self.base / "trace.json"
        env = {**self.env, "GIT_TRACE2_EVENT": str(trace), "GIT_TRACE": str(trace)}
        result = self.guard(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(trace.exists())

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

    def test_single_label_domain_is_refused(self) -> None:
        path = self.message("Add feature\n\nCo-authored-by: Synthetic <wrong@localhost>\n")
        self.assert_refused(self.guard("--commit-msg", path), "line 3")

    def test_package_versions_are_not_email(self) -> None:
        path = self.message("Bump zod@4.6.5, react@19.3.0 and pkg@1.2.3-beta.1\n")
        result = self.guard("--commit-msg", path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_comment_lines_are_checked(self) -> None:
        # `git commit -m` keeps comment-prefixed lines in the stored message.
        path = self.message(f"Add feature\n\n# Co-authored-by: Synthetic <{OTHER}>\n")
        self.assert_refused(self.guard("--commit-msg", path, "message"), "line 3")

    def test_identity_is_also_checked_in_message_mode(self) -> None:
        self.git("config", "user.email", OTHER)
        path = self.message("Add feature\n")
        self.assert_refused(self.guard("--commit-msg", path), "user.email email")

    def test_configured_hook_blocks_commit(self) -> None:
        self.require_configured_hooks()
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


    def test_configured_hook_blocks_patch_message(self) -> None:
        self.require_configured_hooks()
        self.commit("Base")
        env = {**self.env, "GIT_AUTHOR_EMAIL": EXPECTED}
        (self.repository / "file.txt").write_text("synthetic\n", encoding="utf-8")
        self.git("add", "file.txt")
        self.git("commit", "--quiet", "-m", "Add file",
                 "-m", f"Co-authored-by: Synthetic <{OTHER}>", env=env)
        patch = self.git("format-patch", "-1", "--stdout").stdout
        self.git("reset", "--quiet", "--hard", "HEAD~1")
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(GUARD))} --commit-msg"
        self.git("config", "hook.identity-message-guard.command", command)
        self.git("config", "hook.identity-message-guard.event", "applypatch-msg")
        applied = subprocess.run(["git", "am"], cwd=self.repository, env=self.env,
                                 text=True, capture_output=True, input=patch)
        self.assertNotEqual(applied.returncode, 0)
        self.assertIn("not on the allowlist", applied.stderr)
        self.git("am", "--abort")


class PushTests(GuardFixture):
    def test_outgoing_commit_with_other_author_is_refused(self) -> None:
        commit = self.commit("Add feature", env={**self.env, "GIT_AUTHOR_EMAIL": OTHER})
        updates = f"refs/heads/main {commit} refs/heads/main {ZERO}\n"
        self.assert_refused(self.guard("--pre-push", "origin", "url", stdin=updates),
                            "author email")

    def test_outgoing_commit_message_email_is_refused(self) -> None:
        commit = self.commit(f"Add feature\n\nCo-authored-by: Synthetic <{OTHER}>")
        updates = f"refs/heads/main {commit} refs/heads/main {ZERO}\n"
        self.assert_refused(self.guard("--pre-push", "origin", "url", stdin=updates),
                            "message line 3")

    def test_clean_outgoing_commits_and_deletions_pass(self) -> None:
        commit = self.commit("Add feature")
        updates = (f"refs/heads/main {commit} refs/heads/main {ZERO}\n"
                   f"(delete) {ZERO} refs/heads/old {commit}\n")
        result = self.guard("--pre-push", "origin", "url", stdin=updates)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_commits_on_remote_tracking_branches_are_not_rechecked(self) -> None:
        old = self.commit("Upstream", env={**self.env, "GIT_AUTHOR_EMAIL": OTHER})
        self.git("update-ref", "refs/remotes/origin/main", old)
        commit = self.commit("Add feature")
        updates = f"refs/heads/main {commit} refs/heads/main {old}\n"
        result = self.guard("--pre-push", "origin", "url", stdin=updates)
        self.assertEqual(result.returncode, 0, result.stderr)


class DisposableRepositoryTests(GuardFixture):
    def test_direct_push_from_temporary_repository_is_checked(self) -> None:
        self.git("remote", "remove", "origin")
        commit = self.commit("Add feature", env={**self.env, "GIT_AUTHOR_EMAIL": OTHER})
        url = "https://example.invalid/target.git"
        updates = f"refs/heads/main {commit} refs/heads/main {ZERO}\n"
        self.assert_refused(self.guard("--pre-push", url, url, stdin=updates),
                            "author email")

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
