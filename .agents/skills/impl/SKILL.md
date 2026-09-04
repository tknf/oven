---
name: impl
description: Implement an accepted oven plan or issue scope and run focused validation. Use during the implementation phase; do not stage, commit, or push.
---

# Implement an accepted oven change

## Procedure

1. Read `AGENTS.md`, the accepted plan or issue decision, `package.json` scripts,
   affected source and tests, and the closest existing implementation pattern.
2. Inspect the branch and working tree. Stop before editing if an overlapping
   change has unknown provenance or another write-enabled agent is active.
3. If the specification is contradictory or requires a material new decision,
   return `needs_replan`. Do not silently choose a new public behavior.
4. Implement only the accepted scope. Reuse existing mechanisms and keep the diff
   minimal. Generate migrations or fixtures only through project scripts.
5. When the public surface changes, update the relevant `docs/` guide,
   `skills/oven/SKILL.md` references, and `[Unreleased]` changelog entry together.
6. Run `vp check` and the smallest tests that exercise the changed behavior. Use
   `vp run typecheck` when the targeted path does not already provide equivalent
   type coverage. Leave the full repository test run for final integration unless
   the risk requires it now.
7. Review the complete diff and report changed paths, commands and results,
   skipped coverage, unresolved observations, and any plan deviation.

## Boundaries

- Do not weaken acceptance criteria or tests to make the implementation pass.
- Do not edit workflow definitions or the accepted plan to conceal a deviation.
- Do not stage, commit, push, tag, publish, edit issues, or delegate further.
- Preserve unrelated changes and do not use destructive Git commands.

When called from `$issue`, return `PHASE_RESULT implementer <status>` followed by
the handoff object from `../issue/references/phase-handoff.md`.

Statuses: `ready_for_review`, `needs_replan`, or `blocked`.
