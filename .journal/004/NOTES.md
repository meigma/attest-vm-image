---
id: 004
title: Prepare initial release
started: 2026-07-21
---

## 2026-07-21 11:29 — Kickoff

Goal for the session: Get attest-vm-image ready for its first release today.
Current state of the world: v1 is implemented and merged, hosted acceptance has
validated the real consumer path, and no release exists yet. The known remaining
release work includes evaluating the private-plan diagnostic defect and proving
the initial release plus its released major-version tag.
Plan: Inspect the live release state, address concrete release blockers, then
exercise and verify the smallest complete first-release path.

## 2026-07-21 11:32 — Release App credentials imported

Confirmed the release workflows require repository variable
`MEIGMA_RELEASE_APP_ID` and repository secret
`MEIGMA_RELEASE_APP_PRIVATE_KEY`. Read the numeric `app_id` field and PEM
`key.pem` attachment from the `meigma-release-please` item in the `Meigma`
1Password vault, set both on `meigma/attest-vm-image` with `gh`, and verified
their GitHub metadata showed fresh update timestamps. No secret values were
printed or written to the workspace.

## 2026-07-21 13:07 — Release Please rerun passed

Reran the latest failed Release Please run, `29856755170`, on main commit
`1dc6e443c5093c81c46b519eaadbcefa71664346`. Attempt 2 passed in 16 seconds:
both `Create release app token` and `Run Release Please` succeeded, confirming
the imported repository variable and secret work in the workflow. The run
created release PR #14, `chore(main): release 0.1.1`. The only annotation was a
non-blocking deprecation warning that `actions/create-github-app-token` now
prefers `client-id` over `app-id`.

## 2026-07-21 13:46 — Dependabot backlog resolved

Resolved all four outstanding Dependabot PRs sequentially. Requested
Dependabot-owned rebases, verified each refreshed commit was signed and directly
parented on the evolving main branch, waited for CI, Kusari, and both real-image
integration jobs, then squash-merged exact heads: PR #1 (`jdx/mise-action`
4.2.1) as `f056057`, PR #2 (`actions/cache` 6.1.0) as `268a7fc`, and PR #3
(`@types/node` 26.1.1) as `d1c39dd`. Closed PR #4 (TypeScript 7.0.2) because
the latest `@typescript-eslint` 8.65.0 peer range is `<6.1.0` and CI failed
dependency resolution. Final main runs passed: CI `29866771080`, Integration
`29866770161`, and Release Please `29866770839`. Verified zero open Dependabot
PRs and fast-forwarded local main to `d1c39dd`.

## 2026-07-21 14:09 — Initial release reset to 1.0.0

Confirmed the repository had no tags or releases and that Release Please was
proposing 0.1.1 from the template's 0.1.0 baseline. PR #15 changed the durable
`initial-version` to 1.0.0 and carried `Release-As: 1.0.0`; local
`moon run root:check` and all hosted PR checks passed. Closed superseded release
PR #14, then squash-merged #15 as signed commit `d3bf514` with the override
footer preserved. Release Please run `29868270116` passed and opened PR #16,
`chore(main): release 1.0.0`; verified its manifest, package version, and
changelog all target 1.0.0, and all PR checks passed. Main CI `29868270138` and
Integration `29868270265` also passed. Fast-forwarded local main and removed the
temporary Worktrunk worktree/branch; PR #16 remains open for release review.

## 2026-07-21 16:30 — Docs publication gap confirmed

Read-only live diagnosis confirmed GitHub Pages is enabled at
`https://meigma.github.io/attest-vm-image/` with workflow-based publishing, but
the repository has no Pages workflow, no Pages deployment history, and the URL
returns 404. Compared with `incus-gh-runner`'s `docs-pages.yml`: attest-vm-image
also lacks the MkDocs docs project (`docs/mkdocs.yml`, `docs/moon.yml`,
`docs/pyproject.toml`, and `docs/uv.lock`) that its workflow builds, so adding
only the workflow YAML would not be sufficient.
