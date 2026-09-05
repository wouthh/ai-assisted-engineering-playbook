# Node.js and TypeScript validation example

Pin the package manager and runtime version through the repository's existing files. A globally installed tool is not evidence for the locked project.

| Claim | Representative evidence |
|---|---|
| Formatting and lint | Locked package-manager lint command |
| Type contracts | TypeScript compiler or repository typecheck |
| Domain behavior | Focused unit tests with fake adapters |
| API behavior | Route tests for validation, authorization, and response contracts |
| Persistence | Migration and integration tests against the supported database |
| Build | Production build from the locked dependency graph |
| Full acceptance | The repository's aggregate local check and hosted equivalent |

Do not contact providers from normal tests. Use controlled clocks for schedulers and deterministic identifiers for retry or idempotency tests.
