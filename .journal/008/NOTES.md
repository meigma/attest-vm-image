---
id: 008
title: Start a new work session
started: 2026-07-22
---

## 2026-07-22 22:30 — Kickoff

Goal for the session: not yet stated — the user invoked `/session-new` and will
provide the substantive goal next.

Current state of the world: `main` is clean at `74df230` (v1.2.0 release,
PR #26). Session 007 shipped the three external signing backends (`cosign-key`,
`sigstore-keyless`, `kms`) via PRs #22-#25 and published v1.2.0; `v1`,
`v1.2.0`, and `main` all resolve to the release commit. Open threads carried
forward: GCP/Azure/Vault/OpenBao KMS remain field-test pending, the
private-plan billing rejection is still unclassified, both release workflows
still use the deprecated `app-id` input for `actions/create-github-app-token`,
and `moon run root:check` from the main checkout can trip typescript-eslint's
project limit due to the nested `.wt/` worktrees.

Plan: await the user's stated goal, then plan from there.

## 2026-07-22 22:33 — Signing credential-exposure analysis

The user raised a security concern: for KMS signing, the key is usable before
actual signing, so a vulnerability anywhere in the long parsing sequence could
produce malicious signatures. Assessed against the code and agreed.

Findings:

- Ambient `kms:Sign`-capable credentials exist for the whole job, but signing
  is stage 10 (`src/main.ts:143`). Stages 2-9 parse attacker-influenced input:
  `qemu-img info/check` on the host (`src/disk.ts:56`), libguestfs inspection,
  syft/grype over the FUSE-mounted guest fs, plus the action's own JS deps.
  In-process compromise uses the credentials as a signing oracle; the stage-9
  checksum re-seal does not defend against this.
- Applies to all backends, not just KMS. `cosign-key` is worst (key + password
  exfiltratable -> persistent compromise). KMS is a transient oracle bounded by
  session lifetime with CloudTrail visibility. Keyless/github have the same
  window but transparency-log detection.
- Pattern is ecosystem-wide (GitHub native attestations included); it is the
  gap SLSA L3 addresses by moving signing out of the build job. libguestfs
  `direct`-backend appliance isolation reduces likelihood but does not bound
  the credential-availability window. The action alone cannot fix it because
  ambient credentials are configured at workflow level before it runs.
- Strongest fix: job separation — parse in a credential-free job, hand off via
  the PR #25 evidence manifest, sign in a minimal-surface job. A sign-only
  mode/companion action consuming an existing manifest is the missing piece.
  Compensations: repo/role-pinned KMS key policy, short sessions, CloudTrail
  alerting on `kms:Sign`.

Assessment delivered; no code changes made. Next: await user direction
(possible sign-only mode design).
