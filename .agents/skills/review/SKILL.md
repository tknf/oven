---
name: review
description: Independently review a stable oven diff in fresh read-only context against its request, tests, security requirements, and validation evidence.
---

# Review an oven change

Start only after the writer has stopped and the diff is stable. Review in
read-only mode.

## Review

1. Read `AGENTS.md`, the plan or request, acceptance criteria, and affected
   canonical docs.
2. Read `git status`, `git diff`, and evidence from
   `node scripts/issue_workflow_evidence.mjs`. Use Node directly because Vite+ may
   initialize caches in a read-only environment.
3. Complete static review before evaluating runtime results. Trace the changed
   execution path and check correctness, public compatibility, validation,
   authentication and authorization, CSRF/origin handling, secret exposure, error
   paths, concurrency, resource bounds, types, migration safety, and docs/skill
   synchronization as applicable.
4. Confirm that tests can fail for the defect or behavior they claim to cover.
   Flag weakened assertions and missing boundary coverage.
5. If a blocking finding exists, return it before evaluating runtime validation.
   Otherwise verify that the supplied results match the current HEAD and content
   fingerprint and cover the risk. Report missing validation as a finding; do not
   rerun the unfiltered repository suite.
6. Report findings first in descending severity. Include exact locations,
   evidence, impact, and the smallest safe correction. Do not report speculative
   best practices as defects.

For a re-review, inspect the corrected area and its direct dependencies. Repeat the
full review only when a new concrete risk appears or the affected area cannot be
bounded.

## Boundaries

- Do not fix even small findings yourself.
- Do not stage, unstage, format, commit, push, tag, publish, or edit GitHub state.
- Do not start another agent or modify caches.
- Do not dismiss a failing check as pre-existing without evidence from the base
  revision.
- Leave Git stage and push consistency to the deterministic safety gate; do not
  require a second LLM integration review.

Return findings in descending severity with exact paths and lines, then end with
one of `REVIEW_RESULT passed`, `REVIEW_RESULT rework_required`,
`REVIEW_RESULT needs_decision`, or `REVIEW_RESULT blocked`.
