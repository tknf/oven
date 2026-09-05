---
name: issue
description: Have the primary session own an oven issue or substantial request from investigation through implementation, validation, and authorized integration.
---

# Own an oven issue end to end

The primary session is the task owner. It investigates, plans, implements, fixes,
validates, and integrates the requested change itself. Do not create subagents
merely to assign ordinary phases. Commit, push, issue edits, tags, releases, and
publication remain limited to actions explicitly authorized in the user's request.

Read [Git safety gates](references/git-safety.md) before the first mutation and
again before integration.

## Workflow

1. If the user supplied an issue number, read its body and all comments. Use only
   that issue or request and do not infer another number or requirement.
2. Read `AGENTS.md`, relevant canonical docs, source, declarations, tests,
   installed types, and `package.json` scripts. Run `$issue-slop-check` when work
   originates from a GitHub issue.
3. Fetch `origin/main`, collect workflow evidence, establish provenance for every
   existing change and outgoing commit, and pass the start gate before modifying
   repository or external state.
4. Use `$plan` only when the decision complexity warrants it. A small change may
   use an in-thread scope or an authorized issue comment. Resolve routine choices
   from evidence; ask only when the answer changes acceptance, public behavior,
   security policy, compatibility, or scope.
5. Use `$impl` and implement the accepted scope in the primary session. Run
   focused checks while the diff is changing.
6. Require a fresh `reviewer` for security, authentication, authorization,
   session, database migration, storage consistency, concurrency, packaging,
   major architecture, or similarly high-impact work. Otherwise decide whether
   independent review is worth its cost from the concrete risk and impact.
7. Fix findings in the primary session. Re-review the changed area and direct
   dependencies when review is mandatory. Stop if the same blocking finding
   survives two fixes or a correction requires a material new decision.
8. Move durable plan decisions to canonical documentation, preserve necessary
   technical invariants in code comments, and remove a temporary plan when its
   work is complete. Create follow-up issues only when authorized.
9. Use `$wrapup` for final validation, explicit staging, commit, push, and issue
   updates within the user's current authorization.

## On-demand delegation

- Use `researcher` for a large repository search, an external specification, or
  independent fact gathering. Require facts, inferences, and unknowns to be
  separated.
- Use `worker` only for mechanical bulk work whose exclusive file or directory
  ownership, acceptance criteria, and focused validation can be stated exactly.
  While it runs, the primary session does not modify repository or external state.
- Start `reviewer` without inherited conversation. Provide the request or issue,
  accepted scope, paths, diff, tests, and matching validation evidence, but not the
  writer's conclusions or defense.
- Use `auditor` only for a requested or warranted deep cross-cutting audit. It does
  not replace change review.

Do not stop merely because a subagent is unavailable unless mandatory independent
review cannot be completed; in that case, do not push.

## Manual checks and stopping conditions

Classify an automated-test gap as `blocking` when its result could change scope or
acceptance, otherwise as an `observation`. Do not integrate with an unresolved
blocking check. Carry observations into the final report and authorized issue
update.

Stop and report the exact recovery action when user authority is missing,
repository evidence changes unexpectedly, another writer or unknown change is
present, validation or mandatory review fails, or a safety gate rejects the base,
commit sequence, staged paths, working tree, branch, or secret metadata state.
Resume the same workflow after the blocker is resolved; do not require the user to
invoke `$issue` again.
