---
name: issue
description: Carry an oven issue or substantial request through planning, implementation, independent review, and integration with role-specific Codex agents. Use when the user asks for the complete workflow rather than one phase.
---

# Orchestrate an oven issue

This skill coordinates the phase skills and custom agents. The primary agent
orchestrates; it does not implement or review the work itself. A full workflow may
prepare a commit, but commit, push, issue edits, tags, and publication remain
limited to actions explicitly authorized in the user's request.

## Agent routing

Before starting, verify the definitions in `.codex/agents/`:

| Phase | Agent | Skill | Expected result |
| --- | --- | --- | --- |
| Plan | `planner` | `$plan` | `ready_for_implementation` |
| Implement | `implementer` | `$impl` | `ready_for_review` |
| Review | `reviewer` | `$review` | `passed` |
| Integrate | `integrator` | `$wrapup` | `ready_for_final_review` or `complete` |

Use `researcher` for bounded read-only fact gathering and `auditor` for a deep
cross-cutting or release audit. They do not replace the change reviewer.

## Start conditions

1. Use only the issue number or request the user supplied. Do not infer one.
2. Inspect the current branch, upstream, HEAD, status, outgoing commits, and active
   agents. Fetch the expected base when network access is available.
3. Identify the owner of every existing change. Stop before writing if overlapping
   changes have unknown provenance.
4. Keep only one write-enabled agent active. The orchestrator does not edit while
   a phase owner is writing.
5. Create a stable `workflowId` from the issue or request and starting HEAD. Keep
   workflow state in the orchestrator thread, not in a temporary repository file.
6. Use `references/phase-handoff.md` after every phase. Recheck repository state
   before starting the next phase.

## Sequence

1. If the request comes from a GitHub issue, run `$issue-slop-check` read-only.
   Stop on `SLOP`; return `HUMAN` decisions to the user; incorporate an evidenced
   `NEEDS-EDIT` correction into planning without mutating the issue unless
   authorized.
2. Start `planner` with only the target, current workflow state, relevant paths,
   and the preceding handoff. Have it use `$plan`.
3. For `needs_user_decision`, retain the workflow state and ask only the material
   questions. Resume the same workflow after the answer without asking the user to
   invoke `$issue` again.
4. After `ready_for_implementation`, verify the plan or accepted scope in the
   repository, then start `implementer` with `$impl`.
5. Stop the implementer and verify the resulting handoff and diff. Start a fresh
   `reviewer` with `$review`; pass repository evidence, not the implementer's
   conclusions as facts.
6. On `rework_required`, start a fresh implementer and then a fresh reviewer. On
   `needs_replan`, return to the planner. Allow at most two implementation retries
   in one workflow.
7. After `passed`, start `integrator` with `$wrapup` in preparation mode. Have a
   fresh reviewer perform integration review of the staged diff without modifying
   it.
8. If integration review passes and commit or push is authorized, start a fresh
   integrator in publish mode. Otherwise stop with the reviewed staged candidate
   and report the exact next authorized action.

## Stop conditions

Stop and report the workflow state when:

- a material user decision or new authorization is required;
- repository evidence changes unexpectedly;
- another writer or an unknown overlapping change is present;
- a blocking manual check remains unresolved;
- two implementation retries do not pass review;
- a phase result is incomplete or inconsistent with the repository; or
- remote divergence makes the planned integration unsafe.

An agent error may be retried once only if repository state is unchanged. Do not
count an infrastructure-only retry as implementation rework.

## Phase results

- Planner: `ready_for_implementation`, `issue_rejected`,
  `needs_user_decision`, `blocked`
- Implementer: `ready_for_review`, `needs_replan`, `blocked`
- Reviewer: `passed`, `rework_required`, `integration_rework_required`,
  `needs_replan`, `blocked`
- Integrator: `ready_for_final_review`, `complete`, `blocked`

Treat a result as unsuccessful when its handoff is missing required evidence.
