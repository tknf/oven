---
name: review
description: Independently review a stable oven diff against its plan, issue, tests, security requirements, and documentation. Use after implementation or for final staged-diff review.
---

# Review an oven change

Start only after the writer has stopped and the diff is stable. Review in
read-only mode.

## Implementation review

1. Read `AGENTS.md`, the plan or request, acceptance criteria, affected canonical
   docs, full `git diff`, and current `git status`.
2. Complete static review before running tests. Trace the changed execution path
   and check correctness, public compatibility, validation, authentication and
   authorization, CSRF/origin handling, secret exposure, error paths, concurrency,
   resource bounds, types, migration safety, and docs/skill synchronization as
   applicable.
3. Confirm that tests can fail for the defect or behavior they claim to cover.
   Flag weakened assertions and missing boundary coverage.
4. If a blocking finding exists, return it before expensive runtime validation.
   Otherwise run or reuse `vp check` and the smallest relevant tests. A prior
   result is reusable only when HEAD and relevant content are unchanged; identify
   reused results explicitly.
5. Report findings first in descending severity. Include exact locations,
   evidence, impact, and the smallest safe correction. Do not report speculative
   best practices as defects.

## Integration review

When the integrator has staged a final candidate, inspect `git diff --cached`,
unstaged changes, staged paths, final validation receipts, changelog decisions,
and commit boundaries. Do not change the index, files, or validation state.

## Boundaries

- Do not fix even small findings yourself.
- Do not stage, unstage, format, commit, push, tag, publish, or edit GitHub state.
- Do not dismiss a failing check as pre-existing without evidence from the base
  revision.

When called from `$issue`, return `PHASE_RESULT reviewer <status>` followed by the
handoff object from `../issue/references/phase-handoff.md`.

Statuses: `passed`, `rework_required`, `integration_rework_required`,
`needs_replan`, or `blocked`.
