# Java and Kotlin validation example

Use the repository wrapper and declared JDK. Keep host integration behind project-owned ports so most tests run without the external application.

| Claim | Representative evidence |
|---|---|
| Compile compatibility | Maven or Gradle wrapper with the declared toolchain |
| Domain behavior | Focused JUnit tests |
| Integration boundary | Fake adapter or fixture-backed contract tests |
| Persistence | Migration and repository integration tests |
| Packaging | JAR contents, manifest, dependency, and isolated launch checks |
| Lifecycle safety | Connect, disconnect, cancellation, and unsupported-state tests |
| Full acceptance | The repository's documented wrapper or check script |

Treat a packaged JAR as an artifact, not proof of live host compatibility. Report fixture, packaged, compatibility-layer, and native-host evidence separately.
