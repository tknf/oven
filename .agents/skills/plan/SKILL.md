---
name: plan
description: Have the primary session investigate an oven issue or request and produce an implementation-ready plan without implementing it.
---

# Plan an oven change

The primary session executes this skill. Work only from the issue number or
request the user provided; never infer an issue number.

## Procedure

1. Read `AGENTS.md`, the request or complete issue discussion, relevant guides,
   affected source and tests, and `package.json` scripts.
2. For a GitHub issue, run `$issue-slop-check` before accepting its premise.
3. Reproduce or trace current behavior. Resolve stale line numbers by symbol and
   content. Verify external APIs from installed types or primary documentation.
4. Decide routine implementation details from repository evidence. Ask the user
   only when a product, compatibility, security, legal, or scope decision changes
   the public result or acceptance criteria.
5. Classify manual checks as `blocking` when their result can change scope or
   acceptance, otherwise as `observation`. Do not finalize a plan with an
   unresolved blocking check.
6. For work with several design decisions or acceptance criteria that an issue
   comment cannot keep clear, write one temporary plan at
   `docs/plans/<issue-number>-<kebab-case-slug>.md`. For a small change, a concise
   in-thread scope or issue comment is enough. Do not create a plan file based on
   file count or merely to satisfy a template.
7. Define the goal, current evidence, chosen design and reasons, allowed files,
   explicit exclusions, risks, migration or compatibility impact, testable
   acceptance criteria, and validation commands.

## Boundaries

- Do not modify implementation code, tests, generated files, or release state.
- Before changing a plan file, issue, index, or commit, read
  `../issue/references/git-safety.md` and pass the applicable gate. Do not stage,
  commit, push, tag, publish, or edit GitHub state unless the user explicitly
  included that action in the planning request.
- Do not expand the design for hypothetical future requirements.
- Do not read secret-bearing files.

Report the accepted design, testable acceptance criteria, exclusions, manual
checks, affected paths, and any artifact or external state changed.
