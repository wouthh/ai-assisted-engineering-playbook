# PHP and Symfony validation example

Adapt the commands to the repository's documented runtime. Do not assume host PHP matches a containerized project.

| Claim | Representative evidence |
|---|---|
| Syntax and style | PHP-CS-Fixer or the repository formatting check |
| Types and contracts | PHPStan at the repository's configured level |
| Domain behavior | Focused PHPUnit unit tests |
| Doctrine behavior | Integration tests with the supported database |
| Migration safety | Forward migration from representative old state plus compatibility or rollback evidence |
| API boundary | HTTP tests for validation, authorization, and error contracts |
| Full acceptance | The repository's documented Composer, Make, or Docker gate |

Use synthetic fixtures. Resolve configuration through the existing application entry point rather than inventing a second test bootstrap.
