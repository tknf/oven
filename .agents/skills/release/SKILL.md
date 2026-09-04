---
name: release
description: Prepare or publish an explicitly authorized Semantic Versioning release of @tknf/oven. Use for version bumps, changelog finalization, release commits, tags, and the tag-triggered npm release workflow.
---

# Release `@tknf/oven`

This workflow handles package releases. A request to prepare a release does not
authorize creating or pushing a tag. Publishing requires explicit authorization
for the exact version.

## Choose the version

- `major`: incompatible public API, default, behavior, or runtime support change.
- `minor`: backward-compatible public API or subpath addition, including a
  deprecation without removal.
- `patch`: backward-compatible bug or security fix.
- Documentation-only and repository-only changes do not bump the package version.

Confirm the target version with the user when more than one SemVer interpretation
is reasonable. Verify that the version and tag are not already published.

## Prepare

1. Start from a reviewed, clean release branch based on current `origin/main`.
2. Review every `[Unreleased]` entry against the commits being released. Move the
   entries to `## [X.Y.Z] - YYYY-MM-DD` and leave a new empty `[Unreleased]`
   section at the top.
3. Run `vp pm version X.Y.Z -- --no-git-tag-version`. Confirm `package.json` and
   any package-manager state changed as expected.
4. Run `vp check`, `vp run typecheck`, `vp test`, and `vp run build`. Inspect the
   packed file list, version, exports, and package name. Record environmental
   skips.
5. Stage explicit release paths and obtain a read-only review of the staged diff.

## Publish

1. Require explicit authorization for version `X.Y.Z` and confirm the staged diff
   still matches the passed review.
2. Commit with subject `Release vX.Y.Z` and a `Verification:` body.
3. Create annotated tag `vX.Y.Z` on that exact commit.
4. Fetch and verify remote state, then push the release branch and tag without
   force. The tag triggers `.github/workflows/release.yml`, which publishes npm.
5. Verify the GitHub Actions result and the npm version before reporting success.

Never move or reuse a tag, run a duplicate manual publish, expose registry
credentials, or publish a prerelease until the workflow supports the intended npm
dist-tag.
