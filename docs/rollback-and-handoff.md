# Rollback and handoff

Rollback is part of design because not every previous state is safe to restore.

## Choose the recovery mechanism

For ordinary Git changes, prefer a normal revert commit in a new pull request. It preserves reviewability and avoids invalidating collaborators' history.

For deployments, use the platform's versioned rollback or redeploy a known revision. For migrations, decide whether rollback means a reverse migration, a forward repair, or restoring a verified backup. For credentials, revocation is intentionally irreversible; never restore a compromised value.

## Record before mutation

Capture only what recovery needs:

- repository and revision;
- relevant settings or deployment revision;
- data or schema version;
- package or artifact digest;
- exact target of any destructive operation;
- backup location and verification;
- known external side effects.

Do not put secrets into the handoff.

## Treat rollback as a new mutation

Before reversing a change, ask:

- Would this reintroduce a security or privacy issue?
- Has new data been written under the new schema?
- Would an old binary understand the current data?
- Could the old deployment repeat an external action?
- Have provider credentials or permissions changed?
- Will collaborators reintroduce incompatible history?

A failed verification does not automatically authorize rollback when rollback has its own risk.

## Verification after delivery

Do not stop at a successful command. Re-query the external state, verify the expected revision, run a fresh smoke check, and confirm that unrelated settings or resources did not change.

For a Git merge, inspect the live default branch and exact file set. For a deployment, observe the target route and critical behavior. For a package, install or inspect the produced artifact in the platform environment that the claim covers.

## Self-contained handoff

Use the [rollback-handoff template](../templates/rollback-handoff.md). A useful handoff states:

- completed changes;
- exact current state;
- validation that ran;
- validation that did not run;
- open reviews or checks;
- blockers and required authority;
- rollback consequences and commands;
- safe next action.

The next engineer should be able to continue without reading an entire transcript or rerunning already completed destructive work.
