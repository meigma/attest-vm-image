# Proposal: Sign-Only Mode (Credential-Isolated Signing)

Status: draft, awaiting user approval
Session: 008
Date: 2026-07-22

## Problem

All signing backends require credentials (ambient cloud credentials for
`kms`, encrypted key + `COSIGN_PASSWORD` for `cosign-key`, OIDC for
`sigstore-keyless`/`github`) to be present in the job environment for the
entire action run. Signing happens at stage 10 (`src/main.ts:143`), but
stages 2-9 parse attacker-influenced input on the host: `qemu-img
info/check` (`src/disk.ts:56`), libguestfs orchestration, syft/grype over
the FUSE-mounted guest filesystem, plus the action's own dependency tree.
Code execution gained during parsing can use the co-resident credentials
as a signing oracle (kms/keyless/github) or exfiltrate key material
outright (cosign-key). The stage-9 checksum re-seal does not defend
against an in-process attacker.

## Goal

Let operators run validation in a credential-free job and signing in a
minimal-surface job, using the existing evidence-manifest handoff (PR #25)
as the boundary. The sign job re-verifies digests and invokes the existing
signing engine; it never parses the image.

## Non-goals

- A reusable workflow (rejected by user as less ergonomic; may layer on
  later for keyless trusted-builder identity).
- Making job-A evidence *content* trustworthy. A compromised validate job
  can still emit self-consistent false evidence; job separation protects
  the key/oracle, bounds forgery to the run's own statements, and keeps
  compromise detectable. Closing the content gap is SLSA trusted-builder
  territory, out of scope.
- Re-validating the image in the sign job.

## Design

### Shape: subdirectory action

New action at `sign/action.yml`, consumed as
`meigma/attest-vm-image/sign@v1`, with its own committed bundle
(`dist/sign/index.js`; `main:` references it relative to `sign/`). A
separate action keeps the main action's contract untouched (no
mode-conditional `disk-path` requiredness) and gives the sign job a
minimal input surface.

### Inputs

- `evidence-manifest`: path to `evidence-manifest.json` (default
  `./evidence/evidence-manifest.json`).
- `signer`: required; `github`, `sigstore-keyless`, `cosign-key`, or
  `kms`. `none` is invalid here.
- `signing-key`: same contract and validation as the main action
  (required for `cosign-key`/`kms`, rejected otherwise).
- `github-token`: same default (`github.token`) for the `github` backend.
- `disk-path` (optional): when provided, re-hash the disk and require it
  to match the manifest's recorded digest. Not required because signers
  sign digests, never disk bytes — the evidence directory alone crosses
  the job boundary; the image does not need to be uploaded/downloaded.

Signer/key validation is shared with the main action by extracting the
existing logic from `src/inputs.ts` into a reusable helper (no behavior
change for the main path).

### Verification before signing (all fail closed)

1. Manifest parses, `schemaVersion === '1'`.
2. `result === 'pass'`; a failing result is never signed (same policy as
   the main action).
3. The manifest is unsigned: no `*-attestation` evidence entries and no
   `attestationUrl`. Re-signing an already-signed manifest is refused.
4. Every evidence entry resolves and matches: files are resolved as
   `dirname(manifest) + basename(recorded path)` — `src/main.ts`
   guarantees co-location with fixed basenames — and each file is
   re-hashed and compared to its recorded `sha256`. Any mismatch or
   missing file aborts. Duplicate roles/basenames are rejected.
5. The `validation-predicate` entry parses as an in-toto `Statement`,
   and its subject digest equals the manifest's `artifacts.disk.sha256`.
6. SBOM format is derived from the manifest `mediaType`; the entry must
   be present (signers read the SBOM body for the SBOM predicate).
7. If `disk-path` was provided, the re-hashed disk matches
   `artifacts.disk.sha256`.

### Signing and promotion

Build a `SignContext` from the verified manifest (disk path recorded in
the manifest is used for subject naming only) and dispatch through the
existing `selectSigner`/`Signer.sign` unchanged — all backend behavior,
privacy semantics, self-verification, and atomic bundle promotion carry
over. On success, atomically rewrite the manifest in place with the
bundle entries and `attestationUrl` appended (same final shape the main
action produces when signing inline), and set the same outputs
(`attestation-bundle-path`, `attestation-url`).

### Testing

- Unit: manifest verification matrix — tampered evidence digest, missing
  file, `result: fail`, already-signed manifest, subject/disk digest
  mismatch, duplicate roles, bad schema version, optional disk-path
  mismatch; signer dispatch parity with the main action.
- Integration (`.github/workflows/integration.yml`): add a two-job
  split — validate with `signer: none`, upload the evidence dir, sign in
  a separate job with the account-free `cosign-key` backend, verify the
  bundles. This is also the living documentation of the pattern.
- Package: second rollup entry; `check-dist` already diffs the whole
  `dist/`, so the new bundle is covered.

### Documentation

- New how-to: credential-isolated signing (the two-job pattern, why, and
  the threat model boundary — what it does and does not protect).
- `docs/docs/reference.md`: new anchored sections for the sign action's
  inputs/outputs and failure catalog entries (anchor contract preserved;
  other docs link, never restate).
- `docs/docs/signing.md`: recommend job separation for `kms` and
  `cosign-key`; note keyless/github also benefit.
- README: mention the companion action in the documentation index.

### Release

Conventional `feat(sign)` PRs; release-please minor bump → v1.3.0. All
doc examples pin `@v1` per existing convention.

## Alternatives considered

- `mode: sign-only` input on the main action: overloads `disk-path`
  requiredness and mixes two contracts in one input surface; rejected.
- Reusable workflow: enforces topology and gives keyless a pinned
  `job_workflow_ref` identity, but user finds it less ergonomic;
  deferred as a possible later layer, unblocked by this design.
