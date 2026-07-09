# oven (npm: @tknf/oven) — Agent & contributor guide

> This file documents _how to work in this repo_ for AI agents and contributors.
> It does not record design specs, past decisions, or rejected ideas (treat the
> code as the single source of truth; don't carry in assumptions about what is
> "correct"). User-facing usage lives in `docs/`; a condensed version for coding
> agents lives in `skills/oven/SKILL.md`.

## 0. Core principles

- **Code is the single source of truth.** Confirm API names, arguments,
  defaults, and behavior against the implementation in `src/**` and its `.d.ts`
  before writing anything. Don't assert from memory. Prefer usage patterns that
  already appear in `test/**/*.test.ts`.
- **External libraries** (Hono, Drizzle, Standard Schema, ...): verify config and
  APIs against their official docs and the real types in `node_modules`, not from
  memory.
- **Keep changes minimal.** No over-engineering, no designing for hypothetical
  future requirements. Check whether an existing mechanism already covers the
  need before adding files, abstractions, or helpers.

## 1. Package manager / commands

- Use vp (vite-plus) for installing and running scripts (no npm / yarn / npx;
  fall back to pnpm only if vp cannot do it).
- Validate through scripts: `vp check` (format/lint), `vp run typecheck`,
  `vp test`. Do not invoke biome / vitest / tsc directly.
- Generate migrations through the project scripts only (never hand-write or edit
  migration files).
- MySQL-backed tests are skipped when `OVEN_MYSQL_TEST_URL` is unset.

## 2. Coding style

- Arrow functions only; no `function` declarations.
- No `any`, no `as unknown as`, no non-null assertion `!`. Prefer `import type`
  and `satisfies`.
- Always type the result of `JSON.parse()` (validate with Standard Schema or
  similar where possible). Prefer `as const` over `enum`.
- Multi-line comments use JSDoc form (not a run of `//`).
- Tests are `.test.ts` only (no JSX literals). Test names are written in English.

## 3. Language policy

As a public OSS package, **everything in the repository is written in English** —
code, tests, docs, config, and commit messages alike. The only Japanese that
remains is genuine locale data (i18n catalog values, the output of a
deliberately Japanese formatter such as `formatWordedDurationJa`, and examples
that demonstrate a non-English locale).

- **English everywhere in the repo:** public docs (`README.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `CHANGELOG.md`), the guides under `docs/`,
  `skills/oven/SKILL.md`, this `AGENTS.md`, every comment in `src/` (both the
  JSDoc that ships in `.d.ts` and internal implementation comments), **test names
  and test comments**, config files, and **commit messages**. `package.json`
  `description` and `keywords` are English too.
- **Chat replies to the user** follow the user's language and are not a repo
  artifact — they are outside this policy.
- **Never bring unrelated third-party framework names onto the public face.** Do
  not describe oven's own features by analogy to Rails / Laravel / Django etc. or
  their specific API names; state the technical meaning in plain terms. oven's own
  stack names are fine (Hono, Drizzle, Standard Schema, Turbo, Stimulus, htmx,
  Vite, Cloudflare, Node, ...). Real code identifiers (e.g. a DB column name) are
  out of scope.
- When in doubt: code (`src/**`) and anything a user sees is English; notes only
  developers read are Japanese.

## 4. Keep docs and the skill in sync (required for any feature change)

When you **add, change, or remove** a public API (behavior, signature, default,
or subpath export), update the following **in the same change**. Never fix one
side and leave the other stale.

- **Guides (`docs/`):** bring the affected guide's minimal example, common
  tasks, and gotchas in line with the implementation. When you add a new subpath
  export, create its dedicated guide and add it to `docs/README.md` (the index)
  and the coverage map — `docs/` is the user's source of truth and must cover
  every subpath export.
- **`skills/oven/SKILL.md`:** bring the subpath cheat-sheet, minimal examples,
  and gotchas / security defaults in line with the implementation. Always reflect
  added/renamed/removed APIs and any change to defaults or security behavior.
- **README:** update only when supported runtimes, install steps, or entry points
  change (keep it lean).

How: don't write examples or cheat-sheets from memory — verify against `src/**`
and `test/**`. Follow the framework-name rule in §3. After the change, run
`vp check`, confirm the relative links / heading anchors (GitHub slug rules) in
`docs/**` still resolve, and confirm no unrelated framework names remain on the
public face.

## 5. Agent workflow

- In environments with a subagent mechanism (e.g. Claude Code): thinking, design,
  review, and acceptance are done by the director (main loop); **writing code is
  delegated to the `implementer` subagent.** Do not delegate implementation to a
  general-purpose agent.
- No blind hand-offs. Delegation prompts must be self-contained (target files,
  the change, completion criteria, verification commands, the `src`/`test` to
  consult). Delegate in small units and review the report and diff before handing
  off the next one.

## 6. Git / publishing

- Commit only when explicitly asked. Push and `npm publish` require per-time user
  confirmation (publish needs `npm login`).
- Stage explicitly and don't sweep in internal notes (`docs/research/*`). Commit
  messages are written in English, concise.
- Operate under the scoped name `@tknf/oven` (the unscoped `oven` is also owned).

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
