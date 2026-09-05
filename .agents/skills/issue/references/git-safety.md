# Git safety gates

Read this reference before an `$issue`, `$plan`, `$wrapup`, or `$release` workflow
changes repository, index, remote, or GitHub state.

After `git fetch origin main`, record:

- the current branch, HEAD, and `origin/main` commit;
- the initial `secretStateFingerprint`;
- the ordered outgoing commits from `origin/main` that belong to the current task;
- existing changed paths whose provenance and inclusion are confirmed; and
- each validation command, result, HEAD, and `contentFingerprint`.

Keep this state in the primary session, not a temporary repository file. Reuse a
validation result only while its HEAD and relevant content fingerprint match.

The evidence script does not read secret contents. It fingerprints filesystem
metadata for ignored and tracked secret paths. Existing ignored secrets do not
block a workflow, but a metadata change after the baseline prevents later gates
from passing. `.env.example` and `.dev.vars.example` are ordinary files.

## Start gate

Inspect `git status` and active agents. Establish provenance before the first
mutation, then run:

```sh
vp run workflow:evidence
vp run workflow:gate start --expected-branch <branch> --baseline-base <origin-main-hash> --baseline-secret-state <hash> [--allow-commit <hash>] [--allow-path <existing-path>]
```

The branch must follow the repository naming rule. Pass `--allow-main` only when
the user explicitly authorized committing directly to `main`. An `--allow-path`
at start is only for a pre-existing change confirmed to belong to this task; do
not predeclare paths that implementation may later create. Stop instead of
stashing, reverting, or staging unrelated changes.

The gate reads the local remote-tracking `origin/main`; it does not fetch. The
preceding fetch establishes the network baseline. An existing outgoing commit is
allowed only when its issue relationship, subject, and changed paths all match the
current task.

## Stage gate

After final validation and diff inspection, stage only the explicit paths that
belong to the task. Never use `git add .` or `git add -A`.

```sh
vp run workflow:gate stage --expected-branch <branch> --baseline-base <origin-main-hash> --baseline-secret-state <hash> [--allow-main] [--allow-commit <existing-or-plan-hash>] --allow-path <path>...
```

The gate requires the staged and total changed paths to match the allowlist
exactly and rejects every unstaged change. It does not repair the index after a
failure.

## Publish and complete gates

After the authorized commit, fetch `origin/main` again and provide every permitted
outgoing commit in order, including the new final commit:

```sh
vp run workflow:gate publish --expected-branch <branch> --baseline-base <origin-main-hash> --baseline-secret-state <hash> [--allow-main] --allow-commit <hash>...
git push -u origin HEAD
git fetch origin <branch>
vp run workflow:gate complete --expected-branch <branch> --expected-head <final-hash> --baseline-secret-state <hash> [--allow-main]
```

The publish gate requires the fetched `origin/main`, outgoing commit sequence,
its ancestry in HEAD, index, and working tree to match. The complete gate requires
the remote branch to point to the expected final commit and the local tree to be
clean. Never force push. If commit is authorized but push is not, stop after the
local commit and report that publish and complete gates were not run.
