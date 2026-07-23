---
id: 007
title: Add private-repository signing backends
date: 2026-07-22
status: complete
repos_touched: [attest-vm-image]
related_sessions: ['003', '006']
---

## Goal

Design and deliver `sigstore-keyless`, `cosign-key`, and KMS signing backends so
private repositories that cannot use GitHub artifact attestations can still
sign the action's provenance, SBOM, and validation evidence. Prove the security
and portability contracts with disposable real-world tests, then release the
result without creating a cloud-account-dependent maintenance burden.

## Outcome

Goal met. PRs #22-#25 added all three external signer families, strengthened
the shared evidence handoff contract, and passed local, hosted, private-consumer,
and live AWS KMS verification. The complete stack was squash-merged to `main`,
all implementation branches and worktrees were removed, and Release Please PR
#26 published v1.2.0 at `74df230`. The moving `v1` tag, exact `v1.2.0` tag, remote
and local `main`, and the public release all resolve to that commit.

## Key Decisions

- Use one shared Cosign engine for encrypted keys, keyless Sigstore, and KMS ->
  all external backends now build the same complete statements, produce the
  same three stable bundle roles, and share fail-closed verification behavior.
- Make privacy semantics explicit by backend -> keyless requires GitHub OIDC,
  exact identity/issuer verification, and a public Rekor entry; key and KMS
  signing disable Fulcio, ambient OIDC, Rekor, and timestamp services.
- Self-verify before atomic promotion -> no backend exposes a partial bundle
  set, outputs, or handoff manifest when signing or verification fails.
- Accept only immutable KMS locators and ambient provider credentials -> aliases,
  unversioned keys, custom AWS endpoints, raw secrets, and fallback behavior
  are rejected before expensive image work.
- Treat public and cloud integration as disposable acceptance exercises -> the
  keyless smoke was label-gated, the private key consumer was archived after
  proof, and the AWS role/policy were deleted after the live KMS canary.
- Remove the persistent AWS KMS workflow after proof -> no reliable account is
  available for recurring CI, so the repository retains account-free unit,
  mock, and validation-failure coverage plus the historical acceptance report.
- Land the four-PR stack by replaying each child onto the newly squash-merged
  parent -> each final PR stayed focused and was rechecked at a tree-identical
  head before merge.

## Changes

- `src/sign/{cosign,statements,index,types}.ts` - added the shared external
  statement/signing engine and dispatch for encrypted-key, keyless, and KMS
  backends.
- `src/{inputs,exec,tools,main,manifest}.ts` and `action.yml` - added strict
  inputs, secret-safe command execution, pinned Cosign acquisition, atomic
  output handoff, and exact Sigstore v0.3 media types.
- `__tests__/` - expanded the suite to 262 tests covering URI contracts,
  redaction, OIDC preflight, privacy invariants, payload verification, rotation,
  failure atomicity, outputs, and manifest ordering.
- `.github/workflows/{integration,keyless-integration}.yml` - added account-free
  encrypted-key coverage and a deliberately opt-in public keyless smoke. The
  temporary KMS canary workflow was removed before merge.
- `docs/docs/` and `README.md` - documented backend selection, permissions,
  privacy, trust anchors, verification, provider configuration, and failure
  modes.
- `dist/` - refreshed the committed JavaScript action bundle with every source
  change.
- `.journal/007/` - recorded the proposal, Phase 0 compatibility probe, private
  consumer proof, AWS KMS canary, and test-retention decision.
- `whzbox` - exercised read-only as a disposable AWS sandbox client; no source
  change was made.

## Open Threads

- Google Cloud KMS, Azure Key Vault, HashiCorp Vault, and OpenBao remain
  implementation- and URI-contract-supported but not live field-tested.
- GitHub's `Feature not available` / `upgrade the billing plan` private-plan
  rejection remains unclassified and surfaces unchanged; the docs explain it.
- The disposable AWS KMS key is disabled and scheduled for deletion on
  2026-07-29. The private consumer repository is archived with Actions and all
  secrets disabled because the CLI token lacked `delete_repo` scope.
- `actions/create-github-app-token` now emits a non-blocking warning that
  `app-id` is deprecated in favor of `client-id`; update both release workflows
  in a future maintenance change.
- Running `moon run root:check` from the main checkout traverses the nested
  `.wt/journal-jmgilman` worktree and can exceed typescript-eslint's default
  project limit. An implementation worktree or clean Git archive is a valid
  verification boundary until `.wt/**` is excluded centrally.

## References

- Proposal: `.journal/007/EXTERNAL_SIGNING_BACKENDS_PROPOSAL.md`
- Compatibility proof: `.journal/007/PHASE0_SIGNING_PROBE_REPORT.md`
- Private consumer proof: `.journal/007/SLICE4_PRIVATE_CONSUMER_REPORT.md`
- AWS KMS proof: `.journal/007/SLICE3_AWS_KMS_CANARY_REPORT.md`
- [PR #22: Cosign key](https://github.com/meigma/attest-vm-image/pull/22)
- [PR #23: Sigstore keyless](https://github.com/meigma/attest-vm-image/pull/23)
- [PR #24: KMS](https://github.com/meigma/attest-vm-image/pull/24)
- [PR #25: signing hardening](https://github.com/meigma/attest-vm-image/pull/25)
- [PR #26: v1.2.0 release](https://github.com/meigma/attest-vm-image/pull/26)
- [v1.2.0](https://github.com/meigma/attest-vm-image/releases/tag/v1.2.0)

## Lessons

- Real Cosign probes found contracts mocks would miss: key-backed defaults can
  publish to Rekor, and an empty `tlogEntries` repeated field may be omitted
  rather than serialized as `[]`.
- A keyless bundle's Rekor body does not store the complete statement, but its
  certificate permanently discloses repository, workflow, ref, commit, and run
  identity; the action must make that disclosure clear before signing.
- Tree equality is a useful invariant for safely restacking squash-merged PRs:
  rewrite ancestry, prove the tree unchanged, then rerun hosted checks on the
  new exact head.
- A successful release PR is not the terminal gate. Inspect the draft, publish
  it deliberately, verify the moving major tag, and wait for all release-commit
  workflows before calling the release complete.
