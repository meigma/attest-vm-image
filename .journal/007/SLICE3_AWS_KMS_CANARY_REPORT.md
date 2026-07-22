# Slice 3 AWS KMS canary report

Status: passed

Date: 2026-07-22

Action commit: `ef9697909734648c269c6892842509a5b7816447`

Disposable consumer repository:
`meigma/attest-vm-image-private-consumer-smoke` (private; secrets and variables
removed, Actions disabled, and repository archived after the proof)

Consumer workflow commit: `8b1613a2fb92c0e02db87207c2048ce7a8060688`

Hosted run: `29938031012`, completed successfully in 3m23s

Region: `us-east-1`

## Trust and permissions

- GitHub exchanged its OIDC token for a short-lived AWS role session; no AWS
  access key was stored in GitHub.
- The trust policy required audience `sts.amazonaws.com` and the exact immutable
  owner-ID/repository-ID subject for the consumer's `master` branch.
- The private repository plan did not support environment protection rules, so
  the IAM subject was bound directly to `refs/heads/master` instead of using an
  unprotected environment subject.
- The inline role policy allowed only `kms:DescribeKey`, `kms:GetPublicKey`, and
  `kms:Sign` on the one canary key. IAM simulation confirmed `kms:Decrypt` and
  `kms:CreateKey` were denied.
- The key was a customer-managed, non-exportable `ECC_NIST_P256` asymmetric key
  with `SIGN_VERIFY` usage.
- The account's pre-existing GitHub OIDC provider was reused and left unchanged.

## Proof

The workflow used the packaged action through an external full-SHA `uses:`
reference, selected `signer: kms`, and supplied the immutable AWS KMS key ARN as
an `awskms:///` locator. It created a seeded QCOW2 image and produced provenance,
SBOM, and validation bundles.

In-job Cosign v3.1.2 verification passed for all three bundles against a public
key exported from KMS. The job also confirmed:

- all unsigned evidence checksums;
- the exact five unsigned roles followed by the three attestation roles;
- `application/vnd.dev.sigstore.bundle.v0.3+json` for every bundle;
- no attestation URL;
- zero transparency-log entries in every bundle; and
- validation predicate `result: pass`.

The one-day artifact was downloaded separately. Local Cosign v3.1.1 repeated
all three verifications against public-key material exported independently
before the workflow. The downloaded `kms.pub` matched that trust anchor exactly
at SHA-256
`74892de4dd2b32d3d6f1395e87e03e6f20eff27432546493efd197e925da9ad4`.
Downloaded checksums, manifest ordering, media types, no-log assertions, and the
validation result also passed.

This satisfies Slice 3's live-provider exit gate for AWS KMS. AWS KMS is now
field-tested; Google Cloud KMS, Azure Key Vault, HashiCorp Vault, and OpenBao
remain supported by URI contract but not yet field-tested.

## Cleanup

- Deleted both GitHub ARN secrets and the region variable.
- Disabled Actions and archived the private consumer repository.
- Deleted the canary role's inline policy and the role itself.
- Disabled the KMS key and scheduled deletion with the minimum seven-day window;
  AWS reports deletion on 2026-07-29.
- Preserved the account's pre-existing GitHub OIDC provider unchanged.
- Moved the local temporary clone, downloaded artifact, trust anchor, and policy
  files to Trash after the journal checkpoint.

## Retention decision

The disposable live-AWS workflow was used only to produce this acceptance
evidence. It is not retained in the product repository, and there is no
long-lived Bash harness or account-dependent KMS CI job. The repository keeps
the production KMS implementation plus account-free unit, mock, and
integration-negative coverage.

Because no reliable AWS account is available for recurring CI, any future live
revalidation is intentionally a fresh disposable exercise. This report remains
the durable record of the 2026-07-22 proof; it is not a promise of continuous
cloud-provider testing.
