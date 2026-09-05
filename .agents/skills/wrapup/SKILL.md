---
name: wrapup
description: Have the primary session finish an oven change with final validation, explicit staging, commit, and authorized external actions.
---

# Finish an oven change

The primary session executes this skill. Read
`../issue/references/git-safety.md` first and retain the starting base, branch,
secret-state fingerprint, permitted outgoing commits, changed paths, and matching
validation evidence.

1. Confirm the accepted scope, stable diff, and absence of unresolved blocking
   checks. Require `REVIEW_RESULT passed` when independent review was mandatory or
   explicitly requested.
2. If a temporary plan exists, move durable decisions to canonical docs, turn
   deferred work into an issue only when authorized, preserve essential technical
   invariants in code comments when appropriate, and remove the completed plan.
3. If the current HEAD and content fingerprint do not already have valid results,
   run `vp check`, `vp run typecheck`, and unfiltered `vp test`. Run `vp run build`
   when package output can change. Record skipped MySQL coverage and other
   environmental limits. Do not report reused evidence as rerun.
4. Reinspect the complete diff. Stage only explicit reviewed paths and pass the
   `stage` workflow gate. Never use `git add .` or `git add -A`.
5. Create one logical commit only when authorized, using the English rules in
   `AGENTS.md`. Do not alter the reviewed index after the stage gate.
6. Fetch `origin/main`, verify the branch, base, and exact outgoing commit sequence
   with the `publish` gate, then push the current branch only when authorized.
   Never force push.
7. Fetch the pushed branch and pass the `complete` gate. Edit or close an issue
   only when separately authorized and when its requested completion condition is
   actually met.

Do not commit or push failed validation, changed review content, an unresolved
blocking check, an unapproved commit, or a gate failure. Use `$release` for tags,
releases, and npm publication.
