---
id: 004
title: Prepare initial release
date: 2026-07-21
status: complete
repos_touched: [attest-vm-image]
related_sessions: [003, 005]
---

## Goal

Prepare attest-vm-image for its first release by making the release automation
operational, clearing maintenance blockers, targeting the intended 1.0.0
version, and closing any publication gaps found along the way.

## Outcome

The release-readiness goal was met. Release Please is authenticated and working,
the compatible Dependabot backlog was resolved, release PR #16 now proposes
1.0.0 and is fully green, and the operator documentation is live on GitHub
Pages. The actual 1.0.0 release remains intentionally unmerged for final review.

PRs #1, #2, #3, #15, and #18 were squash-merged. Obsolete release PR #14 and
the incompatible TypeScript PR #4 were closed. Post-merge CI, Release Please,
GitHub Pages, Dependabot validation, and both real-image integration jobs passed
on main commit `fd127cb`.

## Key Decisions

- Target 1.0.0 instead of inheriting the template's 0.1.x line -> the action's
  v1 contract and hosted acceptance were already complete, so 1.0.0 accurately
  represents the public compatibility commitment.
- Close the TypeScript 7 Dependabot PR -> the current `@typescript-eslint`
  release does not support it, and forcing the update would break dependency
  installation.
- Add the complete MkDocs/Moon/uv project instead of only a Pages workflow ->
  the repository had no documentation build target for a workflow to publish.
- Build docs strictly on pull requests and deploy only from main -> reviewers
  get link/build validation without granting deployment permissions to PR jobs.

## Changes

- GitHub repository release credentials - imported the Release App ID and
  private key from 1Password without exposing secret material.
- `release-please-config.json` - set the durable initial version to 1.0.0 and
  used a one-time release override to regenerate the initial release PR.
- `.github/dependabot.yml` - retained current action/npm updates and added uv
  coverage for the documentation project.
- `docs/` - wrapped the existing operator pages in a pinned Material for MkDocs
  project with Moon build and serve tasks.
- `.github/workflows/docs-pages.yml` - added strict PR builds and least-privilege
  GitHub Pages deployment from main.
- `README.md` - linked users to the published documentation site.

## Open Threads

- Review and merge PR #16 to publish 1.0.0, then verify the GitHub release and
  moving `v1` tag against the released action.
- Dependabot opened PR #19 for Prettier 3.9.6 after the docs merge; it was not
  part of the reviewed closeout and remains open.
- The private-plan GitHub billing rejection still is not translated into the
  action's named unsupported-plan diagnostic.

## References

- [Release PR #16](https://github.com/meigma/attest-vm-image/pull/16)
- [MkDocs publication PR #18](https://github.com/meigma/attest-vm-image/pull/18)
- [Published documentation](https://meigma.github.io/attest-vm-image/)
- [Dependabot PR #19](https://github.com/meigma/attest-vm-image/pull/19)
- `.journal/003/SUMMARY.md`
- `.journal/005/SUMMARY.md`

## Lessons

- `gh pr merge --delete-branch` may report only a local branch deletion failure
  when the branch is mounted in a Worktrunk worktree; verify the remote PR state
  before deciding whether the merge itself failed.
