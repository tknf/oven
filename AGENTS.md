# oven (`@tknf/oven`) — Codex working instructions

Codex reads this file from the repository root. It defines how to work in this
repository; it is not a design-history document. Treat the implementation as the
source of truth, use `docs/` for user-facing guidance, and keep the distributable
Codex skill under `skills/oven/` aligned with both.

## Ground every change

- Confirm public names, arguments, defaults, and behavior in `src/**`, generated
  declarations, and existing usage in `test/**/*.test.ts`. Do not rely on memory.
- Verify external APIs such as Hono, Drizzle, and Standard Schema against their
  official documentation and the installed types in `node_modules`.
- Keep the change as small as the requested outcome permits. Reuse an existing
  mechanism before adding a file, abstraction, or helper, and do not design for a
  hypothetical future requirement.
- Inspect the current branch, upstream, and working tree before editing. Preserve
  unrelated user changes and local-only files. Stop writing when the provenance
  of an overlapping change is unclear.
- Never read `.env`, `.env.*` other than `.env.example`, `secrets/`, or other
  credential-bearing files unless the user explicitly authorizes it.

## Use Vite+ and project scripts

- Use `vp` (Vite+) for dependency and script operations. Do not use npm, yarn, or
  npx. Fall back to pnpm only when `vp` cannot perform the operation.
- Read `package.json` scripts before invoking a tool. Use `vp check`,
  `vp run typecheck`, and `vp test`; do not invoke the formatter, linter,
  TypeScript compiler, or test runner directly.
- Generate migrations and test fixtures through the project scripts. Never create
  or edit a generated migration by hand.
- MySQL-backed tests are skipped when `OVEN_MYSQL_TEST_URL` is unset. State that
  limitation when a change needs MySQL coverage and the variable is unavailable.

## Follow the repository style

- Use arrow functions for JavaScript and TypeScript function values. Overridable
  class hooks remain methods when the base constructor calls them.
- Do not use `any`, `as unknown as`, or non-null assertions. Prefer type guards,
  generics, null checks, `import type`, and `satisfies`.
- Type and, where practical, validate values produced by `JSON.parse()` or other
  external input. Prefer `as const` to `enum`.
- Write multi-line comments as JSDoc rather than consecutive `//` comments.
- Put tests in `.test.ts` files, do not use JSX literals in tests, and write
  `describe`/`test` names in English.

## Write repository artifacts in English

Everything committed to this public repository is English: code, tests, comments,
documentation, configuration, skills, agent definitions, branch names, and commit
messages. The exceptions are genuine locale data, the output of an explicitly
non-English formatter, and examples that demonstrate another locale. Chat replies
may follow the user's language.

Do not describe oven features through unrelated framework analogies or their API
names. State the technical behavior directly. Names in oven's own stack—Hono,
Drizzle, Standard Schema, Turbo, Stimulus, htmx, Vite, Cloudflare, and Node—are
appropriate, as are real identifiers from code.

## Keep public APIs, docs, and the Codex skill synchronized

When a change adds, changes, or removes a public API, signature, default, behavior,
or subpath export, update all affected surfaces in the same change:

- Update the relevant guide under `docs/`, including its minimal example, common
  tasks, and gotchas. For a new subpath export, add a dedicated guide and update
  the index and coverage map in `docs/README.md`.
- Update `skills/oven/SKILL.md` and the affected files under
  `skills/oven/references/`. Keep its subpath map, examples, testing guidance, and
  security defaults consistent with the implementation.
- Update `README.md` only when supported runtimes, installation, or entry points
  change.
- Add a concise entry under `[Unreleased]` in `CHANGELOG.md` for a consumer-visible
  change. Internal refactors, tests, and repository-only automation do not need an
  entry unless they alter the contributor experience.

Verify examples against `src/**` and `test/**`. Afterward, run `vp check`, verify
relative documentation links and GitHub heading anchors, and search public-facing
text for prohibited framework analogies.

## Codex ownership and agents

The `gpt-6-astra` primary/root session is the task owner. Its model is selected by
the host rather than a repository TOML. It owns investigation, planning,
implementation, correction, validation, integration, release preparation, user
communication, and the final diff. Do not delegate ordinary phases merely to
separate roles.

Use only these project subagents, and only when their benefit clearly exceeds the
delegation and integration cost:

- `researcher` for a large repository search, external specification, or
  independent fact gathering;
- `reviewer` for an explicitly requested review or a change with material
  security, compatibility, concurrency, migration, storage, or release risk; and
- `worker` for mechanical bulk edits with exclusive, explicitly named paths and
  acceptance criteria.

The primary session implements and corrects the work. Do not delegate ordinary
planning, implementation, validation, or integration. While `worker` is active,
the primary session must not modify repository or external state.

A reviewer returns concrete blocking defects and non-blocking observations; it
does not control an open-ended correction loop or invent requirements. The
primary session verifies each finding and makes the final decision. After a fix,
allow at most one focused re-review of that finding and its direct dependencies.
Do not repeat a full review unless the user explicitly requests it.

## Codex workflows

Keep workflow skills to distinct user intents:

- `$issue` owns an issue or substantial request end to end. It plans and
  implements directly; it does not invoke `$plan` or `$impl` as phases.
- `$plan` produces a plan and stops before implementation.
- `$impl` implements an already accepted plan or request and stops before commit.
- `$release` handles an explicitly authorized package release.

For ordinary work, inspect the request, branch, `git status`, and relevant code;
make only the necessary plan; implement; run proportionate validation; and inspect
the final diff. Use a reviewer only under the agent rules above. Stage explicit
paths, commit, push, edit issues, tag, or publish only when the user authorized the
specific action.

## Validation strategy

Validation must follow the risk of the change, not a fixed phase sequence:

- Documentation, skills, and agent definitions need only their relevant
  structural or link checks.
- Tooling changes need `vp check` and focused tests for the changed tool.
- Runtime changes need `vp check` and the smallest tests that exercise them.
- Run `vp run typecheck`, unfiltered `vp test`, and `vp run build` only when the
  affected surface or release process warrants them.

Do not rerun a successful check when its relevant inputs are unchanged. A commit
does not invalidate a result when the committed content is identical. If a Git
hook changes content, stop and inspect the diff instead of automatically entering
another full validation cycle.

## Branch rules

- Branch from an up-to-date `origin/main`. Do not commit directly to `main` unless
  the user explicitly requests it.
- Follow the global `{prefix}/{issueID|yyyymmdd}_{name}` naming convention.
  Use the issue number when an issue exists; otherwise use the work start date
  as `yyyymmdd`. Write `name` in lowercase kebab-case, for example
  `feat/85_multipart-upload` or `docs/20260905_storage-guide`.
- Allowed prefixes are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, and
  `release`. Choose the prefix from the primary change.
- Keep one logical change on one branch. Do not mix unrelated cleanup.
- Never use force push unless the user explicitly requests it. Before pushing,
  fetch the remote and confirm the branch, upstream, and outgoing commits.

## Commit rules

- Each commit contains one logical change and stages explicit paths. Do not use
  `git add .` or `git add -A`.
- Write the subject in English, 20–72 characters when practical, in imperative
  form, with no trailing period. Use an established prefix such as `plan: #42 —`
  only when that workflow already uses it.
- Add a blank line after the subject. For non-obvious changes, explain what
  changed, why it changed, and the important boundaries in a concise body.
- For code or configuration changes, add `Verification:` with the commands and
  results actually observed. Use `Not verified:` for checks that were not run.
- Add `Refs #<number>` or `Closes #<number>` only when the relationship is known.
  Do not guess issue numbers.
- Do not add provider-specific trailers, session URLs, or co-authors who did not
  contribute.

## Version and release rules

`package.json` is the package-version source of truth. `CHANGELOG.md` follows Keep
a Changelog and Semantic Versioning.

- `major`: incompatible public API, default, behavior, or runtime support change.
- `minor`: backward-compatible public API or subpath addition; deprecation without
  removal also belongs here.
- `patch`: backward-compatible bug or security fix. Documentation-only and
  repository-only changes do not bump the package version.

Prepare a release only from an explicitly authorized release task:

1. Confirm the target version is unpublished and matches the intended SemVer
   impact. Do not infer a version from incomplete work.
2. Move `[Unreleased]` entries into `## [X.Y.Z] - YYYY-MM-DD`, leaving a new empty
   `[Unreleased]` section at the top.
3. Run `vp pm version X.Y.Z -- --no-git-tag-version`; do not hand-edit generated
   package-manager state.
4. Run `vp check`, `vp run typecheck`, `vp test`, and `vp run build`. Confirm the
   packed files and package version.
5. Commit the release as `Release vX.Y.Z`, create annotated tag `vX.Y.Z`, and push
   the commit and tag only after explicit authorization for that release.
6. The tag-triggered GitHub Actions workflow publishes to npm. Do not run a manual
   publish in addition to it.

Do not move or reuse a release tag. Do not publish a prerelease until the release
workflow explicitly supports an appropriate npm dist-tag.

## Git and external actions

- Commit only when the user explicitly asks or invokes a workflow whose request
  explicitly includes committing. Push, tags, releases, issue edits, and npm
  publication require authorization for that specific action.
- Keep the index unchanged during read-only review. The primary session stages
  only reviewed paths and does not sweep in internal notes such as
  `docs/research/*`.
- Use the scoped package name `@tknf/oven`; the unscoped `oven` name is also owned.

## Final verification

Run the checks required by the validation strategy and report what was actually
run. For workflow instructions, skills, or agent definitions, run
`vp run check:workflow-safety`. Do not run the application test suite solely
because workflow documentation changed.
