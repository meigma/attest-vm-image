# Slice 4 private-consumer acceptance report

Status: passed

Date: 2026-07-22

Action commit: `9ce3ee47c64a8aa211916394424c5b0d60617af3`

Disposable consumer repository:
`meigma/attest-vm-image-private-consumer-smoke` (private; removed after the
proof)

Consumer workflow commit: `98eaed30112342d49cd15eef083419fc7249eab4`

Hosted run: `29935058715`, completed successfully in 4m45s

## Trust and permissions

- The workflow had only `contents: read`; it had no `id-token` or
  `attestations` permission.
- The encrypted private key and password existed only as repository secrets.
- `cosign.pub` was committed as reviewed consumer trust material and was not
  included in the evidence artifact.
- Every action reference, including the tested `attest-vm-image` revision, was
  pinned to a full commit SHA.

## Proof

The private workflow created a seeded QCOW2 image, consumed the packaged action
through an external `uses:` reference, selected `signer: cosign-key` with
`env://COSIGN_PRIVATE_KEY`, and produced all three portable bundles. In-job
Cosign v3.1.2 verification passed for provenance, SBOM, and validation against
the committed public key.

The workflow uploaded the disk and evidence without the public key. After the
run, the artifact was downloaded separately and checked from its extraction
root:

- `sha256sum -c evidence/checksums.txt` verified the disk and all unsigned
  evidence.
- The evidence manifest had the exact five unsigned roles followed by
  provenance, SBOM, and validation attestation roles.
- All three manifest attestation entries used
  `application/vnd.dev.sigstore.bundle.v0.3+json`.
- Local Cosign v3.1.1 independently verified the downloaded validation bundle
  against the separately retained `cosign.pub`, the downloaded disk digest,
  and the exact validation predicate type.
- The verified validation predicate recorded `result: pass`.

This passes Slice 4's private-repository consumer exit gate. It proves the
encrypted-key backend is usable without GitHub's plan-gated signer and that a
consumer can independently verify the validation bundle from downloaded
evidence. It does not replace Slice 3's still-pending live AWS KMS canary.
