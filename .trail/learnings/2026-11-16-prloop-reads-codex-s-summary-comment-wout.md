---
title: "prloop reads Codex's summary comment state to catch an automatic review that finished before its first poll"
author: Wout
date: 2026-11-16
branch: fix/prloop-review-race-and-learnings
cost: { minutes: 4, tokens: 41306 }
id: l-4e75e988
scope: repo
status: active
replaces: l-2a169461
src: agent
touches:
  - AGENTS.md
  - tools/prloop/prloop.mjs
---

## Decided
- Codex's automatic review on a just-opened PR posts no receipt comment ("Reviewed commit"); it only edits its one summary comment, whose hidden `codex-review-state:v1` JSON names the full reviewed commit and status, and whose Code Review row carries the completion time, plus a PR-body 👍 (its 👀 is removed when done). prloop counts that state as clean for the exact head from the completion time, even before headSeenAt, but only after the commit or force-push and with no newer request or bot 👀 after it.
- `pushLearnings` checks every outgoing commit (`git log --name-status`) and refuses merges; an endpoint diff hides a code commit reverted later.

## Tried and ruled out
- Counting an early "Reviewed commit:" comment: Codex posts those receipts only for requested reviews, so it never caught the automatic-review race.

## Watch out
- If Codex changes the summary format, the signal silently disappears (fail-safe: costs a re-request), so recheck a real summary comment body when prloop misses reviews again.

In the code: tools/prloop/prloop.mjs `reviewSummary` and the summary loop in `classify`, `pushLearnings`.
