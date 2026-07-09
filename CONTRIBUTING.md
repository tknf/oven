# Contributing

Contributions to `@tknf/oven` are welcome.

## Development environment

This project uses [Vite+ (vite-plus)](https://viteplus.dev/) as its unified toolchain. The CLI is `vp`. Do not use npm / yarn / npx (the fallback is pnpm).

```sh
vp install          # install dependencies (run after pulling remote changes)
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
- See [`AGENTS.md`](./AGENTS.md) for the full working conventions.

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

## Security

Report vulnerabilities privately following [SECURITY.md](./SECURITY.md), not via a public issue.
