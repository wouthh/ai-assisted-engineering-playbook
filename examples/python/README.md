# Python validation example

Use the repository's locked environment and documented Python range. Do not advertise a version merely because one local interpreter exists.

| Claim | Representative evidence |
|---|---|
| Syntax | `python -m py_compile` for focused modules |
| Style and correctness | Repository-configured formatter, linter, and type checker |
| Behavior | Focused pytest or unittest selection |
| Persistence | Temporary database, migrations, integrity, and foreign-key checks |
| Packaging | Build plus isolated source and wheel smoke tests |
| Platform support | Native test evidence for each claimed platform |
| Full acceptance | The repository's documented locked check command |

Synthetic fixtures should exercise malformed, truncated, duplicate, and boundary-sized input without reading unrelated local data.
