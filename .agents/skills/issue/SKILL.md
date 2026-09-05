---
name: issue
description: Have the primary session own an oven issue or substantial request end to end without phase orchestration.
---

# Own an oven issue end to end

The primary session is the task owner. It investigates, plans, implements, fixes,
validates, and integrates the requested change directly. Do not invoke `$plan`,
`$impl`, or another skill as an internal phase.

Commit, push, issue edits, tags, releases, and publication remain limited to the
specific actions authorized by the user.

## Workflow

1. Read the complete request or issue discussion, `AGENTS.md`, relevant source,
   canonical docs, tests, installed types, and `package.json` scripts. Verify the
   premise against the current repository.
2. Inspect the branch, `git status`, outgoing commits, and existing changes.
   Establish provenance before editing and preserve unrelated work.
3. Make only the plan needed to implement safely. Ask the user only when the
   answer changes public behavior, compatibility, security policy, acceptance, or
   scope.
4. Implement the accepted scope in the primary session and run proportionate,
   focused validation while the diff changes.
5. Use a fresh `reviewer` only when the user requests it or the change has material
   security, compatibility, concurrency, migration, storage, packaging, or release
   risk. The primary session verifies and resolves findings.
6. Inspect the final diff. Run only validation that the affected surface warrants.
   Do not rerun successful checks whose relevant inputs are unchanged.
7. Stage explicit paths and perform only the commit, push, or issue actions the
   user authorized. Fetch before push and never force push.

Use `researcher` only for substantial independent fact gathering and `worker` only
for mechanical bulk edits with exclusive paths. Do not delegate ordinary phases.
Allow at most one focused re-review after fixing a blocking finding; the primary
session makes the final decision and does not enter an approval loop.

Stop for unknown overlapping changes, missing authority, failed relevant
validation, an unresolved material decision, or a mandatory review finding that
cannot be resolved safely.
