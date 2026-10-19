---
title: Dropping wording from mirrored guidance needs the mirror test updated
author: Wout
date: 2026-10-19
branch: docs/drop-temperature-capacity-limits
cost: { minutes: 5, tokens: 52920 }
touches:
  - examples/fictional-order-service/README.md
  - tests/test_utilities.py
  - docs/review-wait-loop.md
  - templates/AGENTS.template.md
---

## Decided
When removing a phrase from the agent-capacity guidance (docs/review-wait-loop.md, templates/AGENTS.template.md), also update the fictional walkthrough README and test_shared_scratch_and_agent_capacity_rules_are_mirrored in tests/test_utilities.py, which assert the same phrase.

## Tried and ruled out
Fixing only the two docs: the gate then fails on the mirror test for both files.

## Watch out
Search the whole repo for the removed term (docs, templates, example README, tests) before the first gate run.
