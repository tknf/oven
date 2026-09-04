# Contributing

Contributions to `@tknf/oven` are welcome.

## Development environment

This project uses [Vite+ (vite-plus)](https://viteplus.dev/) as its unified toolchain. The CLI is `vp`. Do not use npm / yarn / npx (the fallback is pnpm).

```sh
vp install           # install dependencies (run after pulling remote changes)
vp run playground    # start a local admin-panel preview, see playground/README.md
```

## Verification (always run before a PR)

```sh
vp check            # format + lint + type check (oxfmt / oxlint / type checking)
vp run typecheck    # tsc --noEmit (an extra type-only check)
vp test             # two projects: node (L1/L2) + workerd (L3)
```

- MySQL tests are skipped automatically when `OVEN_MYSQL_TEST_URL` is unset. If you touch MySQL code, set the connection URL and run them.
- Tests live in `.test.ts` files only (no JSX literals). Test names are written in English.

## Coding conventions

- Arrow functions only (no `function` declarations).
- Do not use `any` / `as unknown as` / the non-null assertion `!`.
- Prefer `import type` / `satisfies`.
- Multi-line comments use JSDoc style (not consecutive `//`).

### Language

- **Everything in the repository is written in English** — code, tests, docs, config, and commit messages alike. This includes every comment in `src/` (both the JSDoc that lands in `.d.ts` and internal implementation comments) and test names/comments.
- The only Japanese that remains is genuine locale data (i18n catalog values, the output of a deliberately Japanese formatter, and examples that demonstrate a non-English locale).
- Codex contributors should read [`AGENTS.md`](./AGENTS.md) for the repository's
  complete working instructions before changing code or documentation.

## Database migrations

Migrations / test fixtures are generated via scripts (do not hand-write or hand-edit them).

```sh
vp run test-fixtures:generate        # sqlite
vp run test-fixtures:generate:pg     # postgres
vp run test-fixtures:generate:mysql  # mysql
```

## Pull requests

- Keep changes small. Aim for 1 PR = 1 logical change.
- Add tests that cover your change.
- Make sure `vp check` / `vp run typecheck` / `vp test` all pass.
- Add an entry to `[Unreleased]` in `CHANGELOG.md` for any user-facing change.

### Branches

- Branch from an up-to-date `origin/main`.
- Use `{type}/issue-{number}-{kebab-case-slug}` when an issue exists.
- Without an issue, use `{type}/{yyyymmdd}_{kebab-case-slug}`.
- Use one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, or
  `release` as the type.
- Never force push unless the maintainer explicitly requests it.

### Commits

- Keep each commit to one logical change and stage explicit paths.
- Write an English imperative subject, normally 20–72 characters, without a
  trailing period.
- Explain what changed and why in the body when the change is not self-evident.
- For code or configuration changes, include a `Verification:` line with the
  commands and results actually observed.
- Use `Refs #<number>` or `Closes #<number>` only when the relationship is known.
- Do not add tool-specific trailers or non-contributing co-authors.

## Versions and releases

This package follows Semantic Versioning and Keep a Changelog. Incompatible public
API or runtime changes require a major release, backward-compatible additions a
minor release, and backward-compatible fixes a patch release. Documentation-only
and repository-only changes do not bump the package version.

Release preparation uses `vp pm version X.Y.Z -- --no-git-tag-version`, followed
by `vp check`, `vp run typecheck`, `vp test`, and `vp run build`. Release commits use
`Release vX.Y.Z`; the matching annotated `vX.Y.Z` tag triggers the GitHub Actions
npm publish workflow. Do not publish manually in addition to the tag workflow.
Release commits, tags, and pushes require explicit maintainer authorization.

## Security

Report vulnerabilities privately following [SECURITY.md](./SECURITY.md), not via a public issue.
