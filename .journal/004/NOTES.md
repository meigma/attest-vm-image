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
