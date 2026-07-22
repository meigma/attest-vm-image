---
id: 007
title: Start a new work session
started: 2026-07-21
---

## 2026-07-21 21:53 — Kickoff

Goal for the session: Start a fresh journal-backed work session; the substantive
goal has not been provided yet.

Current state of the world: `main` is clean at the v1.1.0 release commit
`2646b5c`. Recent closed work covered hosted acceptance, initial release
preparation, and the operator documentation overhaul. The new session is ready
for the user's actual request.

Plan: Await the substantive goal, then work iteratively and checkpoint
meaningful progress in this session.

## 2026-07-21 22:05 — External signer proposal drafted

Goal: Write a reviewable proposal for `sigstore-keyless`, `cosign-key`, and
`kms` signing support so private repositories without GitHub artifact
attestation access can still sign the action's evidence.

Current findings: The existing action already reserves all three signer names,
the key-reference input, the explicit no-fallback dispatch boundary, and the
three stable bundle roles. Current Cosign is v3.1.2. A local v3.1.1 probe proved
complete bundle creation and key verification, and also proved that relying on
Cosign defaults can create a permanent public Rekor entry even for a key-backed
run. The probe used only public repository files and a throwaway key; no user
secret was exposed. The local throwaway key directory was moved to Trash and is
recoverable there.

Proposal: `.journal/007/EXTERNAL_SIGNING_BACKENDS_PROPOSAL.md` specifies one
shared Cosign engine delivered in a disposable probe plus three vertical slices.
The initial privacy contract makes public Sigstore explicit for keyless and
uses a no-service signing configuration for key/KMS. Implementation has not
started; the next step is user review.

## 2026-07-21 22:30 — Phase 0 compatibility probe passed

Executed the approved disposable probe with Cosign v3.1.2. Local encrypted-key
signing produced and verified provenance, SPDX, and validation v0.3 bundles;
the complete decoded statements matched their inputs, disk plus metadata
subjects verified from precomputed digests, incorrect type/digest and tampered
signature checks failed, and the explicit no-service configuration produced
zero Rekor entries in every bundle.

Hosted run `29893836807` proved an environment-built SLSA v1 predicate exactly
matches `@actions/attest` 3.2.0's OIDC-derived predicate in an ordinary trusted
push. One intentional keyless entry verified using the exact workflow identity
and GitHub issuer; negative identity/issuer checks failed. Live Rekor log index
`2216217956` matched the bundle. Its body stores envelope/payload hashes,
signature, and the full certificate—not the complete statement—but the
certificate permanently exposes repository/workflow/ref/SHA/run identity and
visibility.

Full results and Slice 1 consequences are in
`.journal/007/PHASE0_SIGNING_PROBE_REPORT.md`. The Phase 0 exit gate passed; no
production action code changed. Await explicit approval before Slice 1.

## 2026-07-21 22:32 — Disposable probe cleaned up

After checkpointing the report, deleted remote branch
`feat/phase-0-signing-probe`, its Worktrunk checkout, and its local branch. Main
remains clean at `2646b5c`; the successful hosted run and permanent Rekor entry
remain as the report's evidence.

## 2026-07-22 07:15 — Slice 1 implementation ready for hosted verification

Implemented the approved `cosign-key` vertical slice on
`feat/cosign-key-signing`. The action now lazily acquires digest-pinned Cosign
v3.1.2 binaries for Linux x64/arm64, accepts readable encrypted key files or
`env://NAME`, masks key/password secrets, rejects raw or contradictory key
inputs, and redacts secret-bearing command labels and errors.

The shared external statement builder preserves the three stable roles and
uses the environment-only GitHub Actions SLSA v1 predicate proved in Phase 0.
The key signer creates an explicit no-Fulcio/no-OIDC/no-Rekor/no-TSA config,
signs complete statements, rejects any transparency-log entry or payload drift,
self-verifies each bundle, and atomically promotes the set only after all three
pass. GitHub signing behavior is unchanged; local external signing leaves URL
fields unset.

Added focused unit coverage, an unprivileged hosted integration using a
generated encrypted key with positive and tamper/digest-negative verification,
operator and verifier documentation, and refreshed committed `dist/`. Current
local evidence: 229 tests pass, strict docs build passes, lint/format/audit pass,
and repeated packaging produced identical bundle hashes. The full pre-commit
`root:check` reaches only the expected `check-dist` failure because intentional
`dist/` changes differ from `HEAD`; rerun the full gate after the implementation
commit, then push and verify the real hosted integration before considering the
slice complete.

## 2026-07-22 07:30 — Slice 1 complete and ready for review

Completed the `cosign-key` vertical slice in PR #22 at exact head
`5f8963f931eef0c2764b1e70f9c230a40d2ed89a`. After committing the packaged
action, the full pinned-runtime `moon run root:check` passed with 230 tests plus
format, lint, audit, docs, package, and committed-dist checks.

The first hosted integration exposed one useful Cosign v3 serialization detail:
an empty `verificationMaterial.tlogEntries` repeated field is omitted rather
than emitted as `[]`. Production validation now accepts only omitted or empty
metadata and still rejects every non-empty transparency-log set; focused tests
cover both encodings.

Hosted run `29928056109` then passed at the exact PR head. The legacy GitHub
signer created and verified its three bundles and retained its attestation URL.
The new encrypted-key path generated a throwaway key, signed all three complete
statements with no external transparency or timestamp service, verified the
bundles, confirmed zero transparency-log entries, left the URL unset, and
rejected changed-digest and tampered-signature cases. CI, GitHub Pages, and
Kusari Inspector also passed. Slice 1 is complete; `sigstore-keyless` and `kms`
remain later slices.

## 2026-07-22 07:41 — Slice 2 ready for packaged commit

Started `feat/sigstore-keyless-signing` as a focused stack on the exact green
Slice 1 head; PR #22 remains unmodified and unmerged. The shared Cosign engine
now has a keyless configuration that forces the noninteractive GitHub Actions
OIDC provider, emits a prominent permanent-public-transparency notice, requires
exactly one Rekor entry per bundle, and self-verifies all three bundles against
`${GITHUB_SERVER_URL}/${GITHUB_WORKFLOW_REF}` plus the GitHub Actions issuer.

Input validation now requires the Actions OIDC request environment and names
the missing `id-token: write` permission before tool download or disk access.
No signing key, GitHub API write scope, credential input, permissive identity
pattern, or fallback was added. The opt-in hosted smoke runs only when a
maintainer applies `integration:keyless` to a trusted same-repository PR, so a
normal push cannot create permanent public entries. It includes a no-OIDC job
that checks the packaged early diagnostic and an OIDC-only job that verifies
all three bundles with exact identity and issuer.

Current local evidence: 235 tests pass; format, lint, audit, strict docs, and
Actionlint pass; `dist/` is regenerated; and the packaged entrypoint fails with
the intended named OIDC diagnostic when run without permission. Next: commit,
run the complete committed-dist gate, publish the stacked PR, deliberately
trigger its public smoke once, and inspect the hosted results before declaring
Slice 2 complete.

## 2026-07-22 07:50 — Slice 2 complete and ready for review

Completed `sigstore-keyless` in focused stacked PR #23 at exact head
`1ccf76859f2eca97234d49f84425dd533e32d1cf`, targeting the still-unmerged
Slice 1 branch from PR #22. The PR contains one Slice 2 commit and is ready for
review. The temporary main base was used only to obtain hosted checks, then the
PR was retargeted after every check passed.

Full local `moon run root:check` passed with 235 tests plus formatting, lint,
audit, packaging, and committed-dist verification. Strict docs and Actionlint
also passed. The Diátaxis pass kept procedure in the signing how-to, exact trust
commands in verification, privacy rationale in explanation, and permissions,
egress, outputs, and diagnostics in reference.

Opt-in Keyless integration run `29929926329` passed at the exact head. The
no-OIDC job passed in eight seconds, proving the packaged action names missing
`id-token: write` before disk access. The OIDC-only job passed in 3m10 with no
GitHub API write scope: it signed provenance, SBOM, and validation, required one
public transparency entry per bundle, left URL fields unset, and independently
verified exact certificate identity
`https://github.com/meigma/attest-vm-image/.github/workflows/keyless-integration.yml@refs/pull/23/merge`
plus issuer `https://token.actions.githubusercontent.com`; wrong identity and
issuer both failed. The hosted notice also surfaced the permanent public
repository/workflow/ref/commit/run disclosure. This deliberate smoke created
three permanent public Sigstore entries.

Ordinary hosted run `29929912925` also passed the unchanged GitHub signer,
encrypted Cosign-key signer, unsigned/failure cases, and tamper/digest negative
checks. CI, GitHub Pages, and Kusari Inspector passed. The
`integration:keyless` label was removed after the proof, so no later branch
push can accidentally repeat the public publication. Slice 2 is complete;
`kms` remains Slice 3.

## 2026-07-22 08:26 — Slice 3 ready for packaged commit

Started `feat/kms-signing` as the third focused stack on the exact green Slice 2
head; PRs #22 and #23 remain unmodified and unmerged. Implemented KMS dispatch
through the shared Cosign engine for immutable AWS KMS ARNs, explicit Google
Cloud KMS and Azure key versions, and HashiCorp Vault/OpenBao Transit keys.

The action consumes ambient provider credentials only, masks KMS locators,
redacts locator-bearing Cosign labels and stderr, creates the existing
no-Fulcio/no-OIDC/no-Rekor/no-TSA configuration, exports a temporary public key,
self-verifies all three bundles, and promotes them atomically. Vault/OpenBao get
a second public-key export after all signatures; a changed fingerprint aborts
without exposing bundles. Input validation rejects aliases, unversioned cloud
keys, custom AWS endpoints, unsupported schemes, and missing Transit address or
token environment before disk access.

Added provider dispatch, invalid URI, redaction, missing-auth/no-fallback,
no-transparency, and rotation tests; 254 tests pass. Formatting, lint,
Actionlint, strict docs, audit, packaging, and every full gate except the
expected pre-commit committed-dist comparison pass. The committed action bundle
is refreshed. A main-only manual AWS canary is included behind a protected
`kms-integration` environment and full-SHA-pinned OIDC auth action.

No repository/environment KMS role, key ARN, region, or local AWS credentials
exist, so the real non-exportable-key exit gate cannot run yet without external
AWS provisioning that the approved proposal explicitly excluded. Documentation
labels all five providers as URI-contract supported with live field testing
pending. Next: commit, rerun `moon run root:check`, publish a draft stacked PR,
verify ordinary hosted checks, and leave the exact AWS canary prerequisite
visible rather than claiming the slice was field-tested.

## 2026-07-22 08:38 — Slice 3 published for review

Published KMS Slice 3 as draft PR #24 at exact head
`c15add7ca0ef2ce002069e93b50d5085462a9382`, stacked directly on the Slice 2
branch from PR #23. The review diff contains one KMS-specific commit and 17
files. Merge order remains #22, then #23, then #24.

The complete local `moon run root:check` passed with 254 tests, formatting,
lint, audit, packaging, and committed-dist verification. Strict docs and
Actionlint also passed. Hosted CI, GitHub Pages, Kusari Inspector, and both
ordinary Integration jobs passed on the same exact head while the PR was
temporarily based on `main`; it was then retargeted to the correct stacked base
without changing the head.

PR #24 intentionally remains draft because the live non-exportable AWS KMS
canary is not currently runnable: the repository still has no protected
`kms-integration` environment, AWS role ARN, key ARN, or region. The included
manual main-only workflow captures the proof path after those external
resources are provisioned, without granting KMS access to pull-request code.
Until that run passes, AWS, GCP, Azure, Vault, and OpenBao remain documented as
URI-contract supported with field testing pending rather than production-
proven backends.

## 2026-07-22 08:53 — Slice 4 private-consumer exit gate passed

Started `feat/signing-release-hardening` from exact Slice 3 head `c15add7` and
committed the hardening pass as `9ce3ee47c64a8aa211916394424c5b0d60617af3`.
The audit found one real contract drift: evidence-manifest entries described
v0.3 Sigstore bundles with the old generic media type. Source, tests, docs, and
the packaged action now use the exact
`application/vnd.dev.sigstore.bundle.v0.3+json` value.

Cross-backend orchestration tests now cover all five signer output conditions,
exact five-role unsigned and eight-role signed manifest ordering, every signing
backend being skipped on validation failure, and every signing abort leaving no
handoff manifest or outputs. Hosted Integration assertions cover the same role
and URL contracts; its threshold case selects a valid AWS KMS URI without AWS
credentials, proving validation failure prevents signer invocation. Full local
`moon run root:check` passed with 262 tests, including committed-dist; strict
docs and Actionlint also pass.

Disposable private consumer run `29935058715` passed in 4m45s at exact action
head `9ce3ee4`. The consumer had only `contents: read`, used an encrypted key and
password from repository secrets, retained its public key separately, signed
and verified all three bundles, and uploaded the disk plus evidence. After
download, checksums, exact role order, exact v0.3 media types, and the validation
result passed; local Cosign independently verified the downloaded validation
bundle against the separate public key and disk digest. Detailed evidence is in
`SLICE4_PRIVATE_CONSUMER_REPORT.md`. The disposable repository is ready for
deletion; next is the stacked PR and ordinary hosted checks. The live AWS KMS
canary remains a separate Slice 3 prerequisite.

## 2026-07-22 09:03 — Slice 4 published for review

Published Slice 4 as draft PR #25, stacked directly on `feat/kms-signing` from
PR #24. Its exact final head is
`ef9697909734648c269c6892842509a5b7816447`; the review diff contains two
focused commits and ten files. Merge order remains #22, then #23, then #24,
then #25.

The first hosted CI run exposed a real concurrency race: Moon ran formatting
and packaging together, so Prettier sometimes tried to read Rollup's transient
`rollup.config-*.mjs` after Rollup removed it. Commit `ef96979` adds only the
focused Prettier ignore. Local `moon ci --summary minimal` passed under the same
concurrency, and CI, GitHub Pages, Kusari Inspector, and both ordinary
Integration jobs passed at the exact final head. The Integration run proved the
unsigned, validation-failure, encrypted-key, and GitHub signing contracts in a
seeded VM image.

PR #25 remains draft because its parent KMS slice still needs the separately
provisioned live AWS canary. The private consumer proof remains pinned to the
action-bearing parent commit `9ce3ee4`; the second commit changes only
`.prettierignore`. Repository deletion was attempted after the private proof,
but the current CLI token lacks the separate `delete_repo` scope. Both Cosign
secrets were removed, Actions was disabled, and the private repository was
archived. The local temporary repository and key material were moved to Trash.
