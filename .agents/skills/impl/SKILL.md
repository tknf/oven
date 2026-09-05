---
name: impl
description: Have the primary session implement an accepted oven plan, issue, or request and run focused validation without integrating it.
---

# Implement an accepted oven change

The primary session executes this skill. Use the accepted plan, issue decisions,
or user request as the implementation specification.

## Procedure

1. Read `AGENTS.md`, the accepted plan or issue decision, `package.json` scripts,
   affected source and tests, and the closest existing implementation pattern.
2. Inspect the branch and working tree. Stop before editing if an overlapping
   change has unknown provenance or another write-enabled agent is active.
3. If the specification is contradictory or requires a material new decision,
   stop and report the decision needed. Do not silently choose a new public
   behavior.
4. Implement only the accepted scope. Reuse existing mechanisms and keep the diff
   minimal. Generate migrations or fixtures only through project scripts.
5. When the public surface changes, update the relevant `docs/` guide,
   `skills/oven/SKILL.md` references, and `[Unreleased]` changelog entry together.
6. Run validation in proportion to the changed surface. Use `vp check` for code or
   tooling changes and the smallest tests that exercise changed behavior. Add
   `vp run typecheck`, unfiltered `vp test`, or a build only when the affected
   surface warrants it.
7. Review the complete diff and report changed paths, commands and results,
   skipped coverage, unresolved observations, and any plan deviation.

## Boundaries

- Do not weaken acceptance criteria or tests to make the implementation pass.
- Do not edit workflow definitions or the accepted plan to conceal a deviation.
- Do not stage, commit, push, tag, publish, edit issues, or delegate further.
- Preserve unrelated changes and do not use destructive Git commands.

Report changed paths, commands and results, skipped coverage, unresolved
observations, and any deviation from the accepted scope.
