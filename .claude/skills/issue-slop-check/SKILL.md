---
name: issue-slop-check
description: Before starting work on a GitHub issue, verify it is not AI slop (an auto-generated issue that is ungrounded, hallucinated, already fixed, a duplicate, or over-engineered) by checking it against the codebase as the source of truth. Run this before picking up any issue for implementation. Takes one or more issue numbers as arguments.
---

# Issue AI slop check

Decide whether an issue is "a real problem worth implementing" by verifying it **against the codebase as the primary source of truth**. Do not judge by how plausible the prose sounds, nor by whether the author was a human or an AI. Judge only whether the claims match reality.

## Procedure

1. **Grounding.** Resolve every `file:line`, symbol, and doc heading/wording the issue cites against the current code, one by one. Line numbers drift, so match by symbol name and content (a stale line number is not itself slop). If the issue relies on a file/API/behavior that does not exist, that is a slop signal.
2. **Confirm the problem still exists.** For bugs: read the actual code path and confirm the described defect is present in current `main` (when behavior is involved, get concrete enough to state a repro or a test observation). For docs: open the document and confirm the stale wording or the gap is actually there, at that place.
3. **Check for already-fixed / duplicate.** Review `git log --oneline -30`, `gh issue list --state all`, and recently merged PRs to confirm it is not already fixed and not a duplicate.
4. **Check project fit.** Confirm it does not conflict with the AGENTS.md principles (minimal change, no over-engineering, no designing for hypothetical requirements) or with the known "intentional design decisions" (items explicitly recorded as deliberately NOT filed). A proposal built only from vague superlatives (comprehensive / robust / best practices / scalable) with no concrete grounding is a slop signal.
5. **Check internal consistency.** Confirm the Problem, Proposal, and Acceptance criteria all point at the same problem, and that implementing the proposal actually resolves the Problem.

## Verdicts

| Verdict | Condition | Next action |
|---|---|---|
| **REAL** | Every claim is grounded, current, unaddressed, and project-fitting | Proceed to implementation |
| **NEEDS-EDIT** | The problem is real but the write-up has a material error (wrong root cause, overstated severity, wrong proposal) | Leave a correcting comment on the issue, then implement the corrected version |
| **SLOP** | Hallucinated premise / already fixed / duplicate / ungrounded over-engineering | Do not implement. Comment with evidence (file:line, the fixing commit/PR) and close. For duplicates, add the `duplicate` label and a reference |
| **HUMAN** | The problem is real but needs a spec decision or a trade-off choice | Add the `question` label, comment with the decision needed, and defer to a human |

## Output format

Per issue:

- **Verdict** (REAL / NEEDS-EDIT / SLOP / HUMAN)
- **Verification**: for each checkable claim, "present / absent / changed" with evidence (current `file:line`, or a commit)
- **Rationale** (1-2 sentences)
- **Next action** (start implementing / the correction to make / the closing message / the question for a human)

## Notes

- Verify read-only at this stage (do not change code here).
- Do not mark an issue REAL when its core claim is plausible but unverifiable. If there is no way to verify it, route it to HUMAN.
- Keep closing comments evidence-based and concise. Do not use hostile phrasing (this is a public repo; write in English).
