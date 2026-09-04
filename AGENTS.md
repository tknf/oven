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

## Codex agents

Project agents live in `.codex/agents/*.toml`. Their model and reasoning settings
are deliberate; change them only when the user asks or a measured workflow result
justifies it.

| Agent             | Model          | Reasoning | Access          | Responsibility                                                                      |
| ----------------- | -------------- | --------- | --------------- | ----------------------------------------------------------------------------------- |
| `planner`         | `gpt-5.6-sol`  | `max`     | workspace write | Investigate and produce an implementation-ready plan                                |
| `researcher`      | `gpt-5.6-luna` | `max`     | read-only       | Gather facts from code, tests, history, and primary documentation                   |
| `implementer`     | `gpt-5.6-luna` | `max`     | workspace write | Implement an accepted plan and run targeted validation                              |
| `reviewer`        | `gpt-5.6-sol`  | `ultra`   | read-only       | Review a stable diff independently against its acceptance criteria                  |
| `auditor`         | `gpt-5.6-sol`  | `ultra`   | read-only       | Audit a release, subsystem, or cross-cutting risk in depth                          |
| `integrator`      | `gpt-5.6-sol`  | `max`     | workspace write | Prepare the final candidate, stage explicit paths, commit, and push when authorized |
| `release_manager` | `gpt-5.6-sol`  | `max`     | workspace write | Prepare and publish a SemVer release when explicitly authorized                     |

Use agents when the task benefits from role separation or independent review. Do
not delegate a small edit merely because an agent exists. The primary Codex agent
owns the scope, user communication, final diff, and acceptance.

Delegation prompts must name the target, allowed paths, completion criteria,
source material, and validation commands. The primary agent must review the report
and repository state before starting the next phase. Only one write-enabled agent
may operate on the shared worktree at a time. Read-only agents may run in parallel
when their investigations are independent.

## Codex workflows

Repository workflows are reusable skills under `.agents/skills/`:

| Skill               | Owner                   | Result                                                                         |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `$issue-slop-check` | primary or `researcher` | Read-only issue verdict grounded in current evidence                           |
| `$plan`             | `planner`               | Accepted scope, decisions, risks, and testable acceptance criteria             |
| `$impl`             | `implementer`           | Implementation plus targeted validation, without staging or committing         |
| `$review`           | `reviewer`              | Independent findings-first review of the stable diff                           |
| `$wrapup`           | `integrator`            | Final validation, explicit staging, commit, and optional push                  |
| `$issue`            | primary orchestrator    | Sequential plan, implementation, review, and integration workflow              |
| `$release`          | `release_manager`       | Version bump, changelog finalization, release commit, tag, and authorized push |

For a full issue workflow, the primary agent runs one phase at a time:

1. Establish the branch, upstream, issue or request, and clean ownership of all
   existing changes.
2. Run the read-only issue check when the work originates from a GitHub issue.
3. Have `planner` use `$plan`. Resolve any material product or compatibility
   decision before implementation.
4. Have `implementer` use `$impl` after the plan is accepted.
5. Stop the writer, then have a fresh `reviewer` use `$review` without receiving
   the implementer's conclusions as facts.
6. Return blocking findings to the implementer. Allow at most two implementation
   retries in one workflow; re-plan when the finding changes scope or acceptance.
7. After review passes, have `integrator` use `$wrapup` to run final repository
   checks, stage explicit paths, and commit or push only within the user's current
   authorization.

Phase handoffs use `.agents/skills/issue/references/phase-handoff.md`. A handoff
records repository state, changed paths, validation actually performed, manual
checks, findings, and unresolved items. Do not claim a reused validation result was
rerun. A result is reusable only while the relevant content and HEAD are unchanged.

## Validation strategy

Avoid repeating the full suite on an unchanged diff:

- The implementer runs `vp check` and the smallest relevant tests.
- The reviewer completes static review before running or reusing tests. Blocking
  findings stop the review before expensive validation.
- The integrator runs `vp check`, `vp run typecheck`, and `vp test` once on the
  final candidate. Run `vp run build` when packaging or published output can
  change.
- The release manager reruns the release gate on the exact release commit or
  records which CI gate provides equivalent coverage.

If validation changes files, inspect the new diff and run only the checks that the
new content invalidated. Record commands, scope, results, and skipped coverage.

## Branch rules

- Branch from an up-to-date `origin/main`. Do not commit directly to `main` unless
  the user explicitly requests it.
- Use `{type}/issue-{number}-{kebab-case-slug}` when an issue exists. Otherwise use
  `{type}/{yyyymmdd}_{kebab-case-slug}`.
- Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, and
  `release`. Choose the type from the primary change.
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
- Keep the index unchanged during read-only review. The integrator stages only the
  reviewed paths and does not sweep in internal notes such as `docs/research/*`.
- Use the scoped package name `@tknf/oven`; the unscoped `oven` name is also owned.

## Final verification

For changes that can affect code, tooling, agent behavior, or packaging, run:

```sh
vp check
vp run typecheck
vp test
```

For documentation-only changes, still run checks required by the affected
tooling. Validate every changed skill with the Codex skill validator, verify local
links, and report commands that were skipped. If Vite+ setup or runtime behavior
appears wrong, run `vp env doctor` and include its output in the report.
