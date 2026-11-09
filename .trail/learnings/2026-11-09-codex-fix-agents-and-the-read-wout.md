---
title: Codex fix agents and the read-only .git
author: Wout
date: 2026-11-09
branch: fix/prloop-codex-fix-agent-sandbox
id: l-603e6777
scope: repo
status: active
src: agent
touches:
  - "tools/prloop/prloop.mjs#codexFixAgentConfig"
  - tools/prloop/README.md
---

Codex (checked on 0.167.0) keeps .git read-only in every sandboxed mode, so a fix agent run with --sandbox workspace-write could not stage or commit (EROFS on index.lock or the prloop lock). Ruled out: listing the Git dir in sandbox_workspace_write.writable_roots (still read-only), and running the agent with --sandbox danger-full-access (an agent safety check refused it as an unsandboxed agent). What works: a permission profile (-c default_permissions=<name> plus permissions.<name>.filesystem) that names each Git dir exactly. A linked worktree needs both its own gitdir (.git/worktrees/<name>) and the common dir; Codex protects a gitdir it finds through the .git pointer unless that exact path is granted. The fix agent also writes prloop's state dir (prloop ready). Network goes in permissions.<name>.network={enabled=true, mode="full"}. Under this profile git push succeeds but credential-store prints a harmless lock error, since home stays read-only. Testing codex exec by hand: close stdin (< /dev/null) or it waits for more input; prloop already spawns with stdin ignored.
