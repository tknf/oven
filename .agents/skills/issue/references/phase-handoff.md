# `$issue` phase handoff

Each phase agent returns exactly one status line followed by one JSON object:

```text
PHASE_RESULT <phase> <status>
```

```json
{
  "schemaVersion": 1,
  "workflowId": "issue-42@<starting-head>",
  "phase": "implementer",
  "mode": "implementation",
  "status": "ready_for_review",
  "inputRepository": null,
  "repository": {
    "branch": "feat/issue-42-example",
    "head": "<head>",
    "upstreamRef": "origin/main",
    "upstreamHead": "<upstream-head>",
    "outgoingCommits": [],
    "changedPaths": [],
    "statusEntries": []
  },
  "validationReceipts": [],
  "reusedValidationIds": [],
  "manualVerifications": [],
  "artifacts": {
    "issueNumber": 42,
    "planPath": null,
    "stagedPaths": [],
    "finalCommit": null,
    "pushTarget": null
  },
  "findings": [],
  "unknowns": []
}
```

Use `null` or an empty collection for fields without a value. `inputRepository`
contains the preceding phase's repository object. `repository` reflects the state
observed immediately before the phase result.

## Validation receipt

Create one receipt per command actually run:

```json
{
  "id": "issue-42@<head>/implementer/1",
  "command": "vp test test/routing/example.test.ts",
  "scope": "targeted",
  "targets": ["test/routing/example.test.ts"],
  "result": "passed",
  "exitCode": 0,
  "durationSeconds": 4.2,
  "head": "<head>",
  "summary": "12 tests passed"
}
```

Use `targeted` for focused tests, `repository` for checks such as `vp check`, and
`full` for an unfiltered `vp test`. Never create a receipt for an unrun command.
Reuse a receipt only when HEAD and all content relevant to the command are
unchanged. Put reused receipt IDs in `reusedValidationIds`; do not rewrite them as
new executions.

## Manual verification

Record checks that automated tests cannot perform:

```json
{
  "id": "consumer-upgrade-example",
  "kind": "observation",
  "status": "unverified",
  "description": "Install the packed package in a representative consumer app",
  "environment": "local consumer fixture",
  "impact": "Confirms package-level integration beyond repository tests",
  "result": null
}
```

Use `blocking` when the result can change scope, public behavior, or acceptance;
leave integration stopped while it is unverified. Use `observation` when the
public result does not depend on it and carry the limitation through every later
handoff and final report.

## Long-running commands

Before a command expected to exceed 60 seconds, tell the orchestrator the command
and scope. After it finishes, report the result and duration. Do not create a
repository state file for monitoring.
