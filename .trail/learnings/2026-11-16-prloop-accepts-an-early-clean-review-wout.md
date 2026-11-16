---
title: "prloop accepts an early clean review naming the head, and reposts a timed-out request itself"
author: Wout
date: 2026-11-16
branch: fix/prloop-review-race-and-learnings
id: l-2a169461
scope: repo
status: active
src: agent
touches:
  - templates/AGENTS.template.md
  - tools/prloop/README.md
  - tools/prloop/prloop.mjs
  - tools/prloop/test/prloop.test.mjs
---

## Decided
- A clean bot comment that names the exact current head counts from the commit or force-push time, not from when prloop first saw the head, but only without a current request. An automatic review on a just-opened PR often finishes before `prloop run`'s first poll; a comment naming this exact commit cannot belong to another head.
- A timed-out request on a tested head with no unresolved thread is reposted by `run` itself. The old fix-agent path failed because the agent saw the earlier request and reported nothing_to_do, which blocked the run.
- Learning-only leftovers (new `.trail/learnings/*.md`, uncommitted or in unpushed commits that only add them) are committed and pushed by `run` before the worktree check; the fix-agent prompt also says to commit learnings before `prloop ready`.

## Tried and ruled out
- A generic "nothing_to_do while pending or clean keeps polling" guard: the progress check already treats any reviewer-state change as progress, so the guard was unreachable.

## Watch out
- Unnamed early comments and PR-body reactions from before headSeenAt still never count; the headSeenAt rule protects fast-forwards to old-dated commits.
- Pushing a leftover learning makes a new head, which needs its own review cycle.

In the code: tools/prloop/prloop.mjs `classify` (pushTime, early), `pushLearnings`, the timeout branch in `runAll`'s step.
