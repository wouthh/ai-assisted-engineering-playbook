# Review wait loop

An external review bot can take minutes to answer. An agent that polls GitHub itself spends tokens on every check, and an agent without stop conditions can request reviews or "fix" the same finding forever. The [`prloop`](../tools/prloop/README.md) tool takes over the waiting and the gates, and tells the agent exactly what to do next. The agent still does the engineering work.

## The loop

1. **Implement** the change in the PR branch.
2. **Gate**: run the project's documented validation on the exact tree, then commit and push.
3. **Mark tested**: `prloop mark-tested` records that the gate passed for this head. The marker is local and is cleared when `prloop sync` changes the head.
4. **Ready**: `prloop ready <pr>` passes only when no review thread is unresolved, no request is already pending on this head, the head is marked tested and, inside the PR checkout, the tree is clean and pushed. It lists exactly what is missing otherwise.
5. **Request**: post the review trigger comment once, for example `@codex review`.
6. **Wait**: `prloop wait <pr>` polls quietly and exits with one verdict: `clean`, `findings`, `not_requested`, `requested_while_unresolved`, or `timeout` with the previous request text to repost.
7. **Fix**: for findings, fix valid ones, reply with evidence to invalid ones, resolve addressed threads, and go back to step 2.

When GitHub reports the branch behind or conflicting with its base, `prloop sync <pr>` updates it with the method the repository allows. Append-only files can be merged as a union of lines; any other conflict is aborted and handed back to the agent with the file list.

## Why

- **Fewer tokens.** One `wait` call replaces dozens of agent-driven polls, and its output is one compact JSON object.
- **Current-head evidence.** Only reactions, comments and reviews newer than the head commit or the current request count, matching [review signal interpretation](validation-and-review.md#codex-cloud-review-signals). Eyes, silence and an older thumbs-up are not a clean review.
- **No duplicate requests.** `ready` refuses while a request on the current head is still running; a request becomes repeatable only after it times out.
- **No infinite loops.** The optional `prloop run` supervisor stops with a `blocked` reason on a round limit, an overall deadline, an agent that makes no progress or reports a permission denial, or the same finding returning after two fixes.

Merging remains a separate, explicitly authorized step. `prloop run --merge` only merges a clean current head that GitHub reports mergeable, pinned with `--match-head-commit`.

## Origin

`prloop` replaces a much larger review queue that a private project ran and later retired. That queue clustered findings, ran its own repair workers, and tracked review budgets across rebases. The lessons that survived are small:

- A review is clean only on an explicit current-head signal with no new unresolved threads. Silence, eyes, timeouts, stale approvals and an earlier head's clean result are not clean.
- Resolve a thread only when the current code and validation show the finding is fixed or concretely invalid. An outdated anchor is not evidence.
- Retry transient GitHub errors, but fail closed on ambiguous state instead of starting over.
- Keep the agent responsible for the work and keep every loop bounded.
