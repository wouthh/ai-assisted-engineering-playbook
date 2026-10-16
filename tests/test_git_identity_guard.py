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
NAME = "Synthetic User"
OTHER_NAME = "Synthetic Agent"
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
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME]})
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
        self.git("config", "user.name", NAME)
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

    def test_missing_allowed_names_is_refused(self) -> None:
        self.write_config({"expected_email": EXPECTED})
        self.assert_refused(self.guard(), "has no allowed_names")

    def test_empty_allowed_names_is_refused(self) -> None:
        self.write_config({"expected_email": EXPECTED, "allowed_names": []})
        self.assert_refused(self.guard(), "non-empty list of names")

    def test_wrong_configured_name_is_refused(self) -> None:
        self.git("config", "user.name", OTHER_NAME)
        self.assert_refused(self.guard(), "user.name name")

    def test_wrong_effective_author_name_is_refused(self) -> None:
        env = {**self.env, "GIT_AUTHOR_NAME": OTHER_NAME}
        self.assert_refused(self.guard(env=env), "author name 'Synthetic Agent'")

    def test_wrong_effective_committer_name_is_refused(self) -> None:
        env = {**self.env, "GIT_COMMITTER_NAME": OTHER_NAME}
        self.assert_refused(self.guard(env=env), "committer name 'Synthetic Agent'")

    def test_any_listed_name_passes(self) -> None:
        self.write_config({"expected_email": EXPECTED,
                           "allowed_names": [OTHER_NAME, NAME]})
        env = {**self.env, "GIT_AUTHOR_NAME": OTHER_NAME}
        result = self.guard(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cherry_pick_source_author_name_is_checked(self) -> None:
        self.commit("synthetic", env={**self.env, "GIT_AUTHOR_NAME": OTHER_NAME})
        source = self.git("rev-parse", "HEAD").stdout.strip()
        git_dir = Path(self.git("rev-parse", "--absolute-git-dir").stdout.strip())
        (git_dir / "CHERRY_PICK_HEAD").write_text(source + "\n", encoding="utf-8")
        self.assert_refused(self.guard(), "cherry-pick source author name")

    def test_inherited_trace_destinations_are_not_written(self) -> None:
        trace = self.base / "trace.json"
        env = {**self.env, "GIT_TRACE2_EVENT": str(trace), "GIT_TRACE": str(trace)}
        result = self.guard(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(trace.exists())

    def test_configured_trace2_targets_are_not_written(self) -> None:
        trace = self.base / "configured-trace"
        global_config = self.base / "global.gitconfig"
        lines = "".join(f"\t{key} = {trace}-{key}\n"
                        for key in ("eventTarget", "normalTarget", "perfTarget"))
        global_config.write_text("[trace2]\n" + lines, encoding="utf-8")
        env = {**self.env, "GIT_CONFIG_GLOBAL": str(global_config)}
        result = self.guard(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.base.glob("configured-trace*")), [])

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
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME],
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

    def test_punctuated_and_quoted_local_parts_are_refused(self) -> None:
        for address in ("wrong!@synthetic-mail.net", '"quoted name"@synthetic-mail.net',
                        '"wrong\\!name"@synthetic-mail.net', "wrong@[192.0.2.1]",
                        "wrong@[foo\\]bar]", "https://user@host.synthetic-mail.net/path",
                        "wrong@synthetic-mail.net@1.2.3",
                        "wrong@synthetic-mail.net,docs@example.com",
                        "wrong@synthetic-mail.net@example.com",
                        "wrong@synthetic-mail.net@",
                        "https://wrong@synthetic-mail.net/path.invalid",
                        "wrong@127.0.0.1", "ssh://wrong@127.0.0.1", "https://wrong@1.2.3",
                        "wrong @synthetic-mail.net", "wrong@ synthetic-mail.net",
                        "@synthetic-mail.net", "wrong @ synthetic-mail.net",
                        "wrong (docs) @ (example.com) synthetic-mail.net"):
            with self.subTest(address=address):
                path = self.message(f"Add feature\n\nCo-authored-by: Synthetic <{address}>\n")
                self.assert_refused(self.guard("--commit-msg", path), "line 3")

    def test_valid_leading_punctuation_is_not_trimmed_into_an_allowed_address(self) -> None:
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME],
                           "allowed_message_emails": ["user@synthetic-mail.net"]})
        for word in ("<!user@synthetic-mail.net>", "<{user@synthetic-mail.net>",
                     "?user@synthetic-mail.net",
                     "`user@synthetic-mail.net", "'user@synthetic-mail.net"):
            with self.subTest(word=word):
                path = self.message(f"Add feature\n\nCo-authored-by: Synthetic {word}\n")
                self.assert_refused(self.guard("--commit-msg", path), "line 3")
        path = self.message("Add feature\n\nCo-authored-by: Synthetic <user@synthetic-mail.net>.\n")
        result = self.guard("--commit-msg", path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_address_folded_across_lines_is_refused(self) -> None:
        path = self.message("Add feature\n\nCo-authored-by: Synthetic <wrong\n@\nsynthetic-mail.net>\n")
        self.assert_refused(self.guard("--commit-msg", path), "line 3")
        path = self.message("Add feature\n\nSee wrong\n@\nsynthetic-mail.net\n")
        self.assert_refused(self.guard("--commit-msg", path), "line 4")

    def test_bracketed_split_single_label_address_is_refused(self) -> None:
        path = self.message("Add feature\n\nCo-authored-by: Synthetic <wrong @localhost>\n")
        self.assert_refused(self.guard("--commit-msg", path), "line 3")

    def test_exact_unusual_allowlisted_addresses_pass_in_brackets(self) -> None:
        unusual = ["user@[192.0.2.1]", '"quoted"@synthetic-mail.net']
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME],
                           "allowed_message_emails": unusual})
        path = self.message("Add feature\n\n" + "".join(
            f"Co-authored-by: Synthetic <{address}>\n" for address in unusual))
        result = self.guard("--commit-msg", path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_package_versions_are_not_email(self) -> None:
        path = self.message("Bump zod@4.6.5, react@19.3.0 and pkg@1.2.3-beta.1\n\n"
                            "Scoped @types/react@19.3.0 and @scope/tool, thanks @alice"
                            " and @bob-2.\n")
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


    def test_configured_hooks_refuse_reused_foreign_author(self) -> None:
        self.require_configured_hooks()
        self.commit("Upstream", env={**self.env, "GIT_AUTHOR_EMAIL": OTHER})
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(GUARD))}"
        self.git("config", "hook.identity-guard.command", command)
        for event in ("pre-commit", "prepare-commit-msg"):
            self.git("config", "--add", "hook.identity-guard.event", event)
        before = self.git("rev-parse", "HEAD").stdout
        for arguments in (["--amend", "-m", "Amended"], ["-C", "HEAD"],
                          ["--amend", "--no-verify", "-m", "Amended"]):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    ["git", "commit", "--allow-empty", *arguments], cwd=self.repository,
                    env=self.env, text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("author email", result.stderr)
                self.assertEqual(self.git("rev-parse", "HEAD").stdout, before)


class PushTests(GuardFixture):
    def test_outgoing_commit_with_other_author_is_refused(self) -> None:
        commit = self.commit("Add feature", env={**self.env, "GIT_AUTHOR_EMAIL": OTHER})
        updates = f"refs/heads/main {commit} refs/heads/main {ZERO}\n"
        self.assert_refused(self.guard("--pre-push", "origin", "url", stdin=updates),
                            "author email")

    def test_outgoing_commit_with_other_author_name_is_refused(self) -> None:
        commit = self.commit("Add feature", env={**self.env, "GIT_AUTHOR_NAME": OTHER_NAME})
        self.commit("Follow-up")
        head = self.git("rev-parse", "HEAD").stdout.strip()
        updates = f"refs/heads/main {head} refs/heads/main {ZERO}\n"
        self.assert_refused(self.guard("--pre-push", "origin", "url", stdin=updates),
                            f"commit {commit[:12]} author name")

    def test_outgoing_commit_with_other_committer_name_is_refused(self) -> None:
        commit = self.commit("Add feature",
                             env={**self.env, "GIT_COMMITTER_NAME": OTHER_NAME})
        updates = f"refs/heads/main {commit} refs/heads/main {ZERO}\n"
        self.assert_refused(self.guard("--pre-push", "origin", "url", stdin=updates),
                            f"commit {commit[:12]} committer name")

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


class ForeignIdentityTests(GuardFixture):
    BOT = {"GIT_AUTHOR_NAME": "Synthetic Bot[bot]", "GIT_AUTHOR_EMAIL": "1+bot@example.invalid",
           "GIT_COMMITTER_NAME": "Synthetic Host", "GIT_COMMITTER_EMAIL": "host@example.invalid"}
    ALLOWED = ["Synthetic Bot[bot] <1+bot@example.invalid>",
               "Synthetic Host <host@example.invalid>"]

    def allow(self, identities: object) -> None:
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME],
                           "allowed_foreign_identities": identities})

    def push_foreign_commit(self) -> subprocess.CompletedProcess[str]:
        self.commit("Bump dependency", env={**self.env, **self.BOT})
        head = self.commit("Add feature")
        updates = f"refs/heads/main {head} refs/heads/main {ZERO}\n"
        return self.guard("--pre-push", "origin", "url", stdin=updates)

    def test_configured_foreign_identities_pass_on_push(self) -> None:
        self.allow(self.ALLOWED)
        result = self.push_foreign_commit()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fully_foreign_commit_message_is_not_checked(self) -> None:
        self.allow(self.ALLOWED)
        head = self.commit(f"Bump dependency\n\nSigned-off-by: Bot <{OTHER}>",
                           env={**self.env, **self.BOT})
        updates = f"refs/heads/main {head} refs/heads/main {ZERO}\n"
        result = self.guard("--pre-push", "origin", "url", stdin=updates)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_partly_foreign_commit_message_is_still_checked(self) -> None:
        self.allow(self.ALLOWED)
        env = {**self.env, "GIT_COMMITTER_NAME": "Synthetic Host",
               "GIT_COMMITTER_EMAIL": "host@example.invalid"}
        head = self.commit(f"Add feature\n\nCo-authored-by: Agent <{OTHER}>", env=env)
        updates = f"refs/heads/main {head} refs/heads/main {ZERO}\n"
        self.assert_refused(self.guard("--pre-push", "origin", "url", stdin=updates),
                            "message line 3")

    def test_unconfigured_foreign_identity_is_refused_on_push(self) -> None:
        self.assert_refused(self.push_foreign_commit(), "author email")

    def test_near_miss_foreign_identity_is_refused_on_push(self) -> None:
        self.allow(["Synthetic Bot[bot] <2+bot@example.invalid>", self.ALLOWED[1]])
        self.assert_refused(self.push_foreign_commit(), "author email")

    def test_foreign_identity_is_refused_for_own_settings(self) -> None:
        self.allow(self.ALLOWED)
        self.git("config", "user.name", "Synthetic Host")
        self.git("config", "user.email", "host@example.invalid")
        self.assert_refused(self.guard(), "user.email email")

    def test_malformed_foreign_identities_are_refused(self) -> None:
        for value in ("Synthetic Host <host@example.invalid>", [42],
                      ["host@example.invalid"], ["<host@example.invalid>"]):
            with self.subTest(value=value):
                self.allow(value)
                self.assert_refused(self.guard(), "allowed_foreign_identities")


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


class ForbiddenTermTests(GuardFixture):
    TERM = "Exampleson"
    REMOTE = "https://example.invalid/synthetic.git"

    def setUp(self) -> None:
        super().setUp()
        self.configure()

    def configure(self, **extra: object) -> None:
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME],
                           "forbidden_terms": [self.TERM, "zz-private-term"], **extra})

    def assert_term_refused(self, result: subprocess.CompletedProcess[str],
                            reason: str) -> None:
        self.assert_refused(result, reason)
        self.assertIn("a forbidden term", result.stderr)
        self.assertNotIn(self.TERM.lower(), result.stderr.lower())
        self.assertNotIn("zz-private-term", result.stderr)

    def stage(self, path: str, text: str) -> None:
        target = self.repository / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        self.git("add", path)

    def push(self, url: str = REMOTE, ref: str = "refs/heads/main",
             oid: str = "") -> subprocess.CompletedProcess[str]:
        oid = oid or self.git("rev-parse", "HEAD").stdout.strip()
        updates = f"{ref} {oid} {ref} {ZERO}\n"
        return self.guard("--pre-push", "origin", url, stdin=updates)

    def test_term_in_commit_message_is_refused(self) -> None:
        path = self.message(f"Thanks {self.TERM} <{self.TERM.lower()}@mail.invalid.x>\n")
        self.assert_term_refused(self.guard("--commit-msg", path), "commit message contains")

    def test_term_in_staged_added_line_is_refused(self) -> None:
        self.stage("notes.txt", f"first line\nwritten by A. {self.TERM}\n")
        self.assert_term_refused(self.guard(), "an added line in 'notes.txt'")

    def test_match_is_case_insensitive(self) -> None:
        self.stage("notes.txt", "ZZ-PRIVATE-TERM appears here\n")
        self.assert_term_refused(self.guard(), "an added line in 'notes.txt'")

    def test_term_only_in_removed_line_passes(self) -> None:
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME]})
        self.stage("notes.txt", f"keep\n{self.TERM}\n")
        self.commit("Add notes")
        self.configure()
        self.stage("notes.txt", "keep\n")
        result = self.guard()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_term_in_new_file_path_is_refused(self) -> None:
        self.stage(f"docs/{self.TERM}.md", "harmless\n")
        self.assert_term_refused(self.guard(), "a file path")

    def test_binary_file_content_is_skipped(self) -> None:
        target = self.repository / "blob.bin"
        target.write_bytes(b"\0" + self.TERM.encode())
        self.git("add", "blob.bin")
        result = self.guard()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prepare_commit_msg_arguments_skip_the_staged_check(self) -> None:
        self.stage("notes.txt", f"{self.TERM}\n")
        result = self.guard(self.message("Add notes\n"), "message")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_term_in_effective_name_is_refused(self) -> None:
        env = {**self.env, "GIT_AUTHOR_NAME": f"Synthetic {self.TERM}"}
        self.assert_term_refused(self.guard(env=env), "author name contains")

    def test_term_in_outgoing_commit_diff_is_refused(self) -> None:
        self.commit("Start")
        self.stage("src/app.txt", f"print('{self.TERM}')\n")
        commit = self.commit("Add app")
        self.commit("Follow-up")
        self.assert_term_refused(self.push(),
                                 f"an added line in 'src/app.txt' in commit {commit[:12]}")

    def test_term_in_outgoing_root_commit_path_is_refused(self) -> None:
        self.stage(f"{self.TERM.lower()}/file.txt", "harmless\n")
        commit = self.commit("Add file")
        self.assert_term_refused(self.push(), f"a file path in commit {commit[:12]}")

    def test_term_in_outgoing_commit_message_is_refused(self) -> None:
        commit = self.commit(f"Add feature\n\nReviewed by {self.TERM}")
        self.assert_term_refused(self.push(), f"commit {commit[:12]} message contains")

    def test_term_in_outgoing_merge_against_first_parent_is_refused(self) -> None:
        self.commit("Start")
        self.git("checkout", "--quiet", "-b", "side")
        self.stage("side.txt", f"{self.TERM}\n")
        self.commit("Side")
        self.git("checkout", "--quiet", "-")
        self.git("update-ref", "refs/remotes/origin/side", "side")
        self.git("merge", "--quiet", "--no-ff", "--no-edit", "side")
        self.assert_term_refused(self.push(), "an added line in 'side.txt' in commit")

    def test_clean_outgoing_commits_pass(self) -> None:
        self.stage("a.txt", "clean\n")
        self.commit("Add a")
        self.git("mv", "a.txt", "b.txt")
        self.commit("Rename")
        result = self.push()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_exempt_remote_skips_term_checks(self) -> None:
        self.configure(forbidden_terms_exempt_remotes=[self.REMOTE])
        self.stage("notes.txt", f"{self.TERM}\n")
        self.assertEqual(self.guard().returncode, 0)
        path = self.message(f"About {self.TERM}\n")
        self.assertEqual(self.guard("--commit-msg", path).returncode, 0)
        self.commit(f"About {self.TERM}")
        result = self.push()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_term_in_pushed_annotated_tag_is_refused(self) -> None:
        self.commit("Start")
        self.git("tag", "-a", "v1", "-m", f"Thanks {self.TERM}")
        self.git("tag", "-a", "v1-outer", "-m", "Clean", "v1")
        for ref in ("v1", "v1-outer"):
            with self.subTest(ref=ref):
                oid = self.git("rev-parse", ref).stdout.strip()
                self.assert_term_refused(self.push(ref=f"refs/tags/{ref}", oid=oid), "tag ")

    def test_exemption_follows_the_push_destination(self) -> None:
        exempt = "git@example.invalid:cv.git"
        self.configure(forbidden_terms_exempt_remotes=[exempt])
        self.git("remote", "add", "private", exempt)
        self.commit(f"About {self.TERM}")
        self.assertEqual(self.push(url=exempt).returncode, 0)
        self.assert_term_refused(self.push(), "message contains")
        # The public origin keeps commit-time checks on as well.
        self.stage("notes.txt", f"{self.TERM}\n")
        self.assert_term_refused(self.guard(), "an added line")

    def test_exempt_fetch_url_with_public_push_url_is_checked(self) -> None:
        self.configure(forbidden_terms_exempt_remotes=[self.REMOTE])
        self.git("remote", "set-url", "--push", "origin", "https://example.invalid/public.git")
        self.stage("notes.txt", f"{self.TERM}\n")
        self.assert_term_refused(self.guard(), "an added line")
        self.commit(f"About {self.TERM}")
        self.assert_term_refused(self.push(url="https://example.invalid/public.git"),
                                 "message contains")

    def test_exempt_push_url_counts(self) -> None:
        self.configure(forbidden_terms_exempt_remotes=["git@example.invalid:cv.git"])
        self.git("remote", "set-url", "--push", "origin", "git@example.invalid:cv.git")
        self.stage("notes.txt", f"{self.TERM}\n")
        result = self.guard()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_keys_mean_no_term_checks(self) -> None:
        self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME]})
        self.stage("notes.txt", f"{self.TERM}\n")
        self.assertEqual(self.guard().returncode, 0)
        self.commit(f"About {self.TERM}")
        result = self.push()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_malformed_keys_are_refused(self) -> None:
        for key in ("forbidden_terms", "forbidden_terms_exempt_remotes"):
            for value in ("Exampleson", [""], ["  "], [3], None):
                with self.subTest(key=key, value=value):
                    self.write_config({"expected_email": EXPECTED, "allowed_names": [NAME],
                                       key: value})
                    self.assert_refused(self.guard(), f"{key} must be a list")


if __name__ == "__main__":
    unittest.main()
