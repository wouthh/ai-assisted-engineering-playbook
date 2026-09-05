# Intake and scope

A strong task begins with an observable outcome and an authority boundary. “Improve the repository” is difficult to verify and easy to expand. “Replace one unsafe configuration path, preserve the public interface, run the documented checks, and open an unmerged pull request” can be tested.

## Define the outcome

Write the goal in terms a reviewer can observe. Include the user or operator behavior, the system boundary, and the completion condition. Avoid choosing the implementation before the repository has been inspected.

Useful intake fields are captured in the [task-brief template](../templates/task-brief.md):

- audience and reason;
- current verified state;
- repositories and paths in scope;
- protected inputs;
- external systems;
- explicit exclusions;
- acceptance criteria;
- validation;
- stop conditions.

## Separate authority levels

Treat these as distinct permissions:

1. inspect and report;
2. edit a working copy;
3. commit and push a branch;
4. open or update a pull request;
5. merge;
6. deploy or contact an external provider;
7. delete, rewrite, or otherwise perform a difficult-to-reverse action.

Permission for one level does not automatically grant the next. A terminal phrase such as “finish the fix” adds persistence, not unrelated authority.

## Make exclusions useful

Exclusions should protect plausible adjacent work. Examples include dependency modernization during a configuration fix, repository-wide formatting during a bug fix, live credential validation during static remediation, or deployment during pull-request preparation.

An exclusion is not a reason to ignore a newly discovered safety issue. Stop the affected path, record the finding without exposing it, and request a separately scoped decision.

## Resolve facts before asking preferences

Repository layout, build commands, current branch, existing tests, and API contracts are discoverable facts. Inspect them. Ask the user only for intent or a trade-off that source evidence cannot resolve.

Record assumptions that are safe and reversible. Do not assume a product decision, destructive target, public claim, or provider status merely to keep moving.

## Acceptance before implementation

Write acceptance criteria that cover intended behavior, failure behavior, invariants, and evidence. This avoids designing tests around the first generated solution. Use the [acceptance-criteria template](../templates/acceptance-criteria.md) and make each item falsifiable.

The final task contract should let an implementer proceed without inventing scope while leaving irreversible choices with the person who owns them.
