---
name: issue-slop-check
description: Verify one or more GitHub issues against the current oven codebase and classify each as REAL, NEEDS-EDIT, SLOP, or HUMAN. Use before implementing an oven issue or when asked whether an issue is current, grounded, duplicate, already fixed, or suitable for this project.
---

# Check issue claims against the repository

Treat the current codebase as the primary source of truth. Judge the issue's
claims and project fit, not its writing style or whether a person or model wrote
it. Investigation is read-only by default.

## Verify each issue

1. Resolve every cited file, symbol, line, heading, and behavior. Match changed
   line numbers by symbol or content; a stale line number alone is not a defect.
2. Follow the relevant code path and confirm whether the reported problem exists
   on the current branch. For behavior claims, identify a concrete reproduction or
   test observation. For documentation claims, inspect the exact current wording.
3. Check recent history, closed and open issues, and merged pull requests for a
   prior fix or duplicate. Use read-only GitHub and Git operations.
4. Compare the request with `AGENTS.md`: the proposal must solve a current,
   evidenced problem without unnecessary abstraction or hypothetical scope.
5. Confirm that the problem, proposal, and acceptance criteria describe one
   consistent change and that the proposal would address the verified problem.

## Assign a verdict

| Verdict | Use when |
| --- | --- |
| `REAL` | The core claim is current, evidenced, unaddressed, and fits the project. |
| `NEEDS-EDIT` | The problem is real, but the root cause, severity, proposal, or acceptance criteria contain a material error. |
| `SLOP` | The premise is absent, already fixed, duplicate, or asks for ungrounded over-engineering. |
| `HUMAN` | The problem is plausible or real but requires a product decision, trade-off, or evidence that cannot be obtained. |

Do not classify an unverifiable core claim as `REAL`. Explain uncertainty and use
`HUMAN` when a decision or unavailable evidence is required.

## Report evidence

For each issue, provide:

- the verdict;
- each checkable claim marked present, absent, or changed, with current
  `file:line`, test output, commit, issue, or pull request evidence;
- a concise rationale; and
- the recommended next action, including corrected wording or a proposed public
  comment when useful.

Keep public-facing proposed text concise, factual, and in English. Do not comment,
add labels, close an issue, edit an issue, or otherwise change GitHub state unless
the user explicitly asks for that specific external action. A request to evaluate
an issue authorizes the read-only assessment only.
