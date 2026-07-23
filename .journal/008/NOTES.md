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

## 2026-07-22 22:51 — Sign-only mode chosen; proposal drafted

The user chose sign-only mode over a reusable workflow (ergonomics). Wrote
`SIGN_ONLY_MODE_PROPOSAL.md` after grounding the design in the code.

Load-bearing finding: signers never read disk bytes — statements embed
precomputed digests (`src/sign/statements.ts:41`, `src/sign/github.ts:58`);
only the small SBOM JSON is re-read. So only the evidence directory crosses
the job boundary; the multi-GB image stays in the validate job.

Design highlights: subdirectory action `sign/action.yml`
(`meigma/attest-vm-image/sign@v1`) with its own `dist/sign/` bundle;
consumes `evidence-manifest.json`, fail-closed re-verification (schema,
result=pass, unsigned, per-file digest re-hash resolved against the
manifest dir, statement subject == disk digest, optional disk-path
re-check); dispatches through the existing selectSigner/sign unchanged;
atomically rewrites the manifest with bundles + attestationUrl. Shared
signer/key validation extracted from src/inputs.ts. Integration workflow
gains a two-job artifact-handoff split on the cosign-key backend. Docs:
new credential-isolated-signing how-to + reference.md anchors. Target
v1.3.0.

Next: user approval of the proposal, then implementation.

## 2026-07-22 23:13 — Sign-only action implemented; PR #27 open

User approved the proposal. Implemented in worktree
`.wt/feat-sign-only-action` (branch `feat/sign-only-action`), commit
`f73fca5`, PR #27.

What landed:

- `src/sign-only/{inputs,verify,main,index}.ts` + `sign/action.yml`
  (subdirectory action, `main: ../dist/sign/index.js`, codeql-action
  pattern) + second rollup bundle `dist/sign/index.js`.
- Shared `validateSigningInputs` extracted from `src/inputs.ts`;
  `selectSigner` narrowed to a `SignerSelection` pick (no behavior change).
- 34 new unit tests (296 total). Integration workflow: `build-image`
  uploads `evidence-positive` as artifact `unsigned-evidence`; new
  `sign-evidence` job proves tamper-refusal, cosign-key signing +
  offline verification, and re-sign refusal.
- Docs: `credential-isolation.md` how-to, reference `## Sign action`
  section (inputs/outputs/handoff verification/failure catalog),
  how-it-works `## Why signing can move to a separate job`, cross-links
  in signing.md/index.md/README/mkdocs nav.

Gotchas hit (worth remembering):

- `rollup.config.ts` must stay annotation-free JS: tsconfig `include`
  does not cover it, so `--configPlugin` passes it through unparsed;
  TS annotations break rollup's parser.
- eslint `maximumDefaultProjectFileMatchCount` was sized exactly to the
  allowDefaultProject file count (26); new test files require bumping it
  (now 29).
- Prettier reformats YAML inside markdown code fences — indented job
  fragments get de-indented to column 0, so examples must be
  self-contained starting at `jobs:`.
- Pinned latest artifact actions live: upload-artifact v7.0.1
  `043fb46d`, download-artifact v8.0.1 `3e5f45b2`.

`moon run root:check` and strict docs build pass locally. Next: watch PR
#27 checks (integration sign-evidence job is the real proof), then review.
