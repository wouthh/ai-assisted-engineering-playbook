# Privacy and secrets

AI-assisted work can move sensitive material into prompts, logs, generated fixtures, commit messages, pull requests, and public reports. Privacy therefore belongs in the task contract and validation matrix, not in a final manual glance.

## Minimize inputs

Read only the files and data needed for the task. Do not search unrelated personal directories or load production datasets to create realistic examples. Prefer synthetic fixtures that preserve structure and edge cases without copying content.

Never ask a user to paste a password or token into chat. Use the platform's supported local credential store or secret mechanism, and inspect scope without retrieving the token itself.

## Classify before acting

Distinguish:

- confirmed secret;
- possibly active credential;
- public client configuration;
- placeholder or harmless example;
- personal or proprietary data;
- detector false positive;
- unknown value requiring a decision.

Do not validate a credential against a live provider unless that exact action is authorized. Repository cleanup does not rotate a credential or secure an external service.

## Safe examples

Example configuration should list every required variable and use values that cannot authenticate externally. Use loopback services or reserved domains, and reject secret sentinels in application validation.

```dotenv
DATABASE_URL=postgresql://localhost:5432/example
SIGNING_SECRET=replace-with-a-local-development-secret
EXTERNAL_BASE_URL=https://example.invalid
```

Do not use empty example files or realistic key-shaped strings.

## Redacted evidence

Scanner output can be sensitive even when the scanner labels a finding. Stream raw output through a sanitizer before persistence, store private evidence with restrictive permissions, and publish only category-level results.

The included [redaction check](../scripts/check-report-redaction.py) verifies configured synthetic patterns without printing matched content. It is not a maintained credential detector. Use established scanners and human review for actual repositories.

## Public documentation

Public remediation copy should be truthful without acting as a map to historical sensitive material. It can say that configuration is environment-based, external compatibility is unverified, and production credentials should not be used. Detailed exposure paths and fingerprints belong in private audit evidence.

## History and external copies

Removing a value from the current tree does not remove it from Git history. Rewriting public history can reduce live discoverability but cannot erase existing clones, forks, caches, transcripts, or downloads. Revocation or provider decommissioning is normally the primary security control.

History rewriting requires a repository-specific plan, private backup, local dry run, full verification, and separate force-push approval.
