# Project onboarding and instruction maintenance

Index the repository before adapting instructions, and maintain them as part of ordinary authorized implementation.

## Instruction layers

Codex's global instruction file lives in its Codex home, normally `~/.codex/AGENTS.md`. A non-empty `AGENTS.override.md` takes precedence there. Project instructions are discovered from the project root toward the current directory, with more specific guidance taking precedence. A general home-directory AGENTS.md is not automatically the global policy for every Git repository. Keep the global file concise; the default combined project-instruction limit is 32 KiB. New runs load the instruction chain; existing sessions should explicitly reread changed guidance or restart.

Repository guidance must remain useful without a particular person's global file. Commit the applicable delivery contract in the project, because cloud reviewers do not inherit workstation instructions. An AGENTS.md file guides behavior; it does not enable Codex cloud, install hooks, configure automatic reviews, or enforce branch protection. Verify those capabilities separately and change settings only with authority.

See the official [Codex instruction-discovery guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [GitHub review guide](https://learn.chatgpt.com/docs/third-party/github). Other agents may use different discovery rules; verify rather than assuming compatibility.

## Index a new or existing project

Inspect only the repository and task-relevant dependencies:

1. Actual Git root, authenticated remote identity, default or integration branch, current head, dirty state, in-progress operations, and existing PR.
2. Applicable root/nested AGENTS files, overrides, and existing contributor guidance; record precedence or conflicts.
3. Entry points, domain modules, persistence, side effects, external boundaries, generated artifacts, and protected inputs.
4. Runtime versions, manifests, lockfiles, package manager, supported setup, tests, static tools, CI, packaging, and deployment/rollback documentation.
5. Commands that form the real focused and full validation gates, their required environments, and known limitations.

Use bounded repository search, not a scan of a person's home directory. Do not run untrusted setup commands, start providers, install dependencies, or change a working tree simply to index it. A small linked repository map is enough; do not generate a huge file inventory.

## Initialize or improve AGENTS.md

During an authorized implementation, use [the reusable template](../templates/AGENTS.template.md) if guidance is missing or materially incomplete. Fill it from the evidence above. Preserve stronger local rules, legal notices, and nested instructions. Merge only the missing contract; do not overwrite an existing file with the template or create no-op instruction churn.

For new projects, agree on the product scope and remote/visibility before publication. Add a small runnable test baseline and an appropriate local gate. Select real commands for the stack; do not pretend every JavaScript project uses npm or every backend can run on the host. Record commands not yet run as unverified and remove unresolved template placeholders from the adopted project guidance.

Include narrow instruction changes in the implementation PR, or create a focused guidance PR when instruction maintenance is the task. If an explicit path allowlist excludes AGENTS.md, obtain a scope extension. During questions, audits, planning, or read-only work, report gaps without editing. Do not bulk-rewrite unrelated project instructions.

## Keep the wiring current

When an authorized change alters commands, layout, safety boundaries, or delivery rules, update the affected guidance and canonical documentation in the same PR. Test the documented commands in their proper environment; inspect links and resolve contradictions. Keep current-run logs and transient failures in the task evidence rather than bloating AGENTS.md.

When a lesson is genuinely reusable, propose a normal playbook branch/PR updating the template and relevant documents together. Do not automatically import a new remote template or modify global policy from unreviewed code. Global policy changes remain an owner's decision; local installation and rollback belong in an owner-only ledger. Memory updates use the active agent's permitted mechanism and authorization.

Policy identifier `implementation-review-loop-v1` identifies the contract, not proof that a particular project implements it. Verify the project guidance and actual workflow before claiming adoption. This is an on-task maintenance practice, not an unattended synchronization service.
