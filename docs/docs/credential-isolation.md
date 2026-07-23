# How to isolate signing credentials

Run validation and signing in two different jobs so signing credentials never
share an environment with image parsing. The build job runs the main action with
`signer: none` and uploads its evidence directory as an artifact; a second job
holds the signing credentials, re-verifies the handoff, and signs it with the
`meigma/attest-vm-image/sign@v1` companion action.

While the main action inspects an image, the tools parsing it run next to every
credential in the job's environment. Moving signing to its own job removes
signing credentials from that environment entirely; the reasoning is in
[Why signing can move to a separate job](how-it-works.md#why-signing-can-move-to-a-separate-job).

## Prerequisites

- A workflow that already runs the action and produces evidence with
  `signer: none`. If you do not have one yet, complete
  [Getting started](getting-started.md) first.
- A signing backend chosen with
  [Choose a signing backend](signing.md#choose-a-signing-backend). The backend's
  credentials, permissions, and key handling are exactly the ones described in
  that guide; only the job they live in changes.

## 1. Produce and upload unsigned evidence

In the job that builds and validates the image, run the action with
`signer: none` and upload the evidence directory:

```yaml
jobs:
  validate:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      # Earlier steps build build/disk.qcow2.
      - uses: meigma/attest-vm-image@v1
        with:
          disk-path: build/disk.qcow2
          output-directory: ./evidence
          signer: none

      - uses: actions/upload-artifact@v4
        with:
          name: unsigned-evidence
          path: evidence/
          if-no-files-found: error
```

Two properties of this job matter:

- It declares no signing permissions and configures no signing credentials.
- Only the small evidence directory is uploaded. Signing operates on the digests
  recorded in the manifest, so the image itself never has to cross the job
  boundary.

## 2. Sign in a credential-holding job

A second job downloads the handoff, establishes credentials for the chosen
backend, and runs the sign action. With `signer: kms` on AWS:

```yaml
jobs:
  # The validate job from step 1 stays as is.
  sign:
    needs: validate
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: unsigned-evidence
          path: evidence

      - name: Configure short-lived AWS credentials
        uses: aws-actions/configure-aws-credentials@517a711dbcd0e402f90c77e7e2f81e849156e31d # v6.2.2
        with:
          aws-region: ${{ vars.AWS_KMS_REGION }}
          role-to-assume: ${{ secrets.AWS_KMS_ROLE_ARN }}

      - uses: meigma/attest-vm-image/sign@v1
        with:
          evidence-manifest: evidence/evidence-manifest.json
          signer: kms
          signing-key: ${{ format('awskms:///{0}', secrets.AWS_KMS_KEY_ARN) }}
```

The other backends slot in the same way:

- `cosign-key` — materialize the encrypted key and `COSIGN_PASSWORD` in this job
  only, exactly as in
  [Sign with an encrypted Cosign key](signing.md#sign-with-an-encrypted-cosign-key).
- `sigstore-keyless` — grant `id-token: write` and accept the same permanent
  public disclosure as inline keyless signing.
- `github` — grant `id-token: write` plus `attestations: write`; the published
  attestation and `attestation-url` behave exactly as with inline signing.

Because credentials now live only here, the KMS role, Vault token, or key
password can be scoped to this job's environment (for example a protected GitHub
environment) without granting the build job anything.

## 3. Consume the signed handoff

Before signing, the sign action re-verifies the whole handoff fail-closed —
schema, a passing result, an unsigned manifest, and a fresh digest match for
every evidence file — and refuses anything tampered, incomplete, or already
signed. The exact checks and messages are in
[Handoff verification](reference.md#handoff-verification).

On success it writes the bundles to `attestations/` next to the manifest and
promotes the manifest in place with the three `*-attestation` roles (and
`attestationUrl` for `signer: github`). Read locations from its outputs
(`attestation-bundle-path`, `evidence-manifest-path`) and retain or verify them
as usual with [Verify evidence and attestations](verification.md). A failed run
leaves the manifest untouched and no partial bundles behind.

## Optional: re-check the disk digest

Signing does not need the image, but if the sign job has it anyway, pass
`disk-path` and the sign action re-hashes it against the manifest's recorded
digest before signing:

```yaml
- uses: meigma/attest-vm-image/sign@v1
  with:
    evidence-manifest: evidence/evidence-manifest.json
    disk-path: build/disk.qcow2
    signer: kms
    signing-key: ${{ format('awskms:///{0}', secrets.AWS_KMS_KEY_ARN) }}
```

## What isolation does and does not give you

- It removes signing credentials from the environment that parses the image, so
  a compromise there has nothing to steal and no signing capability to abuse.
- It does not make the evidence content more trustworthy: a compromised validate
  job could still emit self-consistent false evidence, which the sign job would
  faithfully sign. The digest re-verification binds signatures to the exact
  handoff bytes; it cannot vouch for how they were produced. See
  [Why signing can move to a separate job](how-it-works.md#why-signing-can-move-to-a-separate-job).

## Related

- [Publish signed attestations](signing.md)
- [Verify evidence and attestations](verification.md)
- [Reference: Sign action](reference.md#sign-action),
  [evidence-manifest.json](reference.md#evidence-manifestjson),
  [Permissions](reference.md#permissions)
- [How attest-vm-image works](how-it-works.md)
