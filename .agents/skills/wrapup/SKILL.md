---
name: wrapup
description: Integrate a reviewed oven change by running final validation, staging explicit paths, committing, and optionally pushing within the user's authorization. Use only after review passes.
---

# Integrate a reviewed oven change

Use this skill only after an independent review passes. Select preparation or
publish mode explicitly.

## Preparation mode

1. Confirm the branch, upstream, accepted scope, passed review, stable diff, and
   absence of unresolved blocking checks.
2. If a temporary plan exists, move durable decisions to canonical docs, turn
   deferred work into an issue only when authorized, preserve essential technical
   facts in code comments when appropriate, and remove the temporary plan.
3. Run `vp check`, `vp run typecheck`, and `vp test` once on the final content.
   Run `vp run build` when package output can change. Record skipped MySQL coverage
   or other environment limitations.
4. Reinspect the diff after validation. Stage only reviewed explicit paths; never
   use `git add .` or `git add -A`.
5. Return `ready_for_final_review` without committing or pushing.

## Publish mode

1. Require a passed integration review of the current staged diff and verify that
   the index has not changed since that review.
2. Fetch the remote. Confirm the expected base, current branch, upstream, and full
   outgoing commit list. Stop if unrelated commits or remote divergence appear.
3. Create one logical commit using the English rules in `AGENTS.md`. Preserve the
   reviewed index; do not stage again.
4. Push the current branch only when the user's current request explicitly
   authorizes push. Never force push.
5. Edit or close an issue only when separately authorized. Report the commit,
   remote branch, validation evidence, and any remaining observation.

## Boundaries

- Do not integrate failed or changed review content.
- Do not hide validation failures or claim reused evidence was rerun.
- Do not create tags, releases, or npm publications; use `$release` for those.
- Do not delegate further.

When called from `$issue`, return `PHASE_RESULT integrator <status>` followed by
the handoff object from `../issue/references/phase-handoff.md`.

Statuses: `ready_for_final_review`, `complete`, or `blocked`.
