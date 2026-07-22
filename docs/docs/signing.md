# How to sign attestations

Switch a working unsigned run to GitHub-published attestations, public Sigstore
keyless bundles, or portable bundles signed with an encrypted Cosign or KMS key.

## Prerequisites

- A workflow that already runs the action and produces evidence with
  `signer: none`. If you do not have one yet, complete
  [Getting started](getting-started.md) first.
- The action running in the **same job** that built the QCOW2 (see
  [how-it-works.md](how-it-works.md) for why this matters).
- For `signer: github`, a repository whose plan and visibility can issue
  attestations. Check the matrix below.
- For `signer: sigstore-keyless`, a same-repository GitHub Actions run whose
  repository, workflow, ref, commit, run, and certificate identity may be
  disclosed permanently through public Sigstore transparency services.
- For `signer: cosign-key`, Cosign `v3.1.2` on the administrator machine that
  creates the key, plus a separate trusted way to distribute `cosign.pub`.
- For `signer: kms`, an asymmetric signing key, provider credentials established
  before this action runs, and a trusted way to distribute its public key.

## Choose a signing backend

| Backend            | Use it when                                               | Public service                                  |
| ------------------ | --------------------------------------------------------- | ----------------------------------------------- |
| `github`           | The repository can use GitHub's attestation API.          | GitHub OIDC and the GitHub attestation API.     |
| `sigstore-keyless` | Verifiers should trust an exact workflow identity.        | GitHub OIDC, Fulcio, Rekor, CT, and TUF.        |
| `cosign-key`       | A private repository needs portable, key-trusted bundles. | None while signing; bundles stay on the runner. |
| `kms`              | The signing key must remain non-exportable.               | The selected KMS or Transit API only.           |

All signing modes create the same three stable bundle roles. Only `github`
publishes them and sets `attestation-url`.

## Publish with GitHub

### Check your repository is eligible

`signer: github` publishes to the GitHub attestation API, which is gated by
repository visibility and plan. There is no fallback: an ineligible repository
hard-fails the run rather than downgrading to unsigned output.

| Repository visibility                   | Requirement              |
| --------------------------------------- | ------------------------ |
| Public                                  | Any plan.                |
| Private or internal                     | GitHub Enterprise Cloud. |
| Any GitHub Enterprise Server repository | Unsupported.             |

Two more conditions must hold at run time:

- The run must be on the **same repository**, not a fork pull request. Fork pull
  requests receive a read-only token and no OIDC token, so signing cannot run.
- The job must grant the permissions in step 1.

### 1. Grant the signing permissions

`signer: github` needs three job permissions the action cannot grant itself. Add
them to the job that runs the action (the full table is in
[reference](reference.md#permissions)):

```yaml
jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read # read the workspace
      id-token: write # mint the OIDC token that identifies the signer
      attestations: write # publish attestations to the repository
```

The `attestations: write` permission is what makes the default token carry the
scope the action needs — see step 3.

### 2. Set `signer: github`

Change the action step from `signer: none` to `signer: github`. Nothing else
about the step is required to change:

```yaml
- uses: meigma/attest-vm-image@v1
  with:
    disk-path: build/disk.qcow2
    signer: github
```

If you pass `metadata-path`, the provenance attestation covers the metadata
tarball as a second subject in addition to the disk. The SBOM and validation
attestations always cover the disk alone
([reference](reference.md#attestation-bundles)).

### 3. Leave `github-token` at its default

You normally do not set `github-token`. It defaults to `${{ github.token }}`,
and because you granted `attestations: write` in step 1, that token carries the
scope needed to push attestations.

The action reads this token **only** from the `github-token` input — there is no
ambient `GITHUB_TOKEN` environment variable fallback. Override the input only to
supply a different token; if you override it, that token must also carry
`attestations: write`. Setting it to an empty string fails the run
([reference](reference.md#failure-modes)).

### 4. Run the workflow

Trigger the workflow on the same repository (a push or a same-repo pull
request). On a passing result the action publishes three attestations for the
disk, by role:

- **Provenance** — build provenance for the disk (plus the metadata tarball when
  `metadata-path` is set).
- **SBOM** — the software bill of materials.
- **Validation** — the run's primary claim; its URL becomes the
  `attestation-url` output.

The signed Sigstore bundles are written under the evidence directory (default
`./evidence`, or your `output-directory`), and two extra outputs are set:
`attestation-bundle-path` (the bundle directory) and `attestation-url` (the
validation attestation). The ordinary `evidence-manifest-path` output points to
the single handoff document, whose evidence list now includes all three bundles
and whose `attestationUrl` matches the validation URL. Exact filenames,
predicate-type URIs, and subjects are in
[reference](reference.md#attestation-bundles); the output set-conditions are in
[reference](reference.md#outputs).

### 5. Verify the published attestation

Confirm signing happened by checking that `attestation-url` is non-empty in the
step's outputs, or by reading the run log for the three logged attestation URLs.

To verify the published attestation independently — the check a consumer runs —
follow [Verify evidence and attestations](verification.md). The quickest smoke
check from the same runner is:

```yaml
- env:
    GH_TOKEN: ${{ github.token }}
  run: gh attestation verify build/disk.qcow2 --repo ${{ github.repository }}
```

## Sign with public Sigstore keyless identity

Use this mode when GitHub's attestation API is unavailable but the exact GitHub
Actions workflow identity is an acceptable public trust anchor. This mode does
not need `attestations: write` or a managed private key.

### 1. Confirm public disclosure is acceptable

Each successful bundle creates a permanent public Sigstore transparency entry.
The complete statement remains in the retained bundle, while the certificate and
public log disclose the repository, workflow, ref, commit, event, run, and
certificate identity. Use `cosign-key` instead when any of that identity is
confidential.

### 2. Grant only OIDC permission

```yaml
jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write
    steps:
      # Earlier steps build build/disk.qcow2.
      - uses: meigma/attest-vm-image@v1
        with:
          disk-path: build/disk.qcow2
          signer: sigstore-keyless
```

The action checks GitHub's OIDC request environment before downloading Cosign or
reading the disk. It forces Cosign's noninteractive `github-actions` OIDC
provider, signs all three complete statements, and requires one public
transparency entry in each bundle.

### 3. Retain and verify the bundles

`attestation-bundle-path` points to the local `attestations/` directory.
`attestation-url` remains unset because the GitHub attestation API was not used.
Verification must pin the exact workflow identity and GitHub issuer; follow
[Verify keyless bundles](verification.md#verify-sigstore-keyless-bundles).

Remote signing cannot be rolled back. If the second or third signing operation
fails, no partial bundle directory is exposed, but any earlier public
transparency entry remains permanent.

## Sign with an encrypted Cosign key

This mode is intended for private repositories that cannot or do not want to use
GitHub's attestation API. It does not request OIDC, publish to Rekor, or use a
timestamp authority. The caller is responsible for protecting the private key
and establishing trust in the public key.

### 1. Generate and distribute the key pair

Run this once on an administrator machine, not in the image-build workflow:

```bash
export COSIGN_PASSWORD='<strong unique password>'
cosign generate-key-pair
```

Store the contents of `cosign.key` and the password as separate GitHub Actions
secrets, for example `COSIGN_PRIVATE_KEY` and `COSIGN_PASSWORD`. Distribute
`cosign.pub` to consumers through an independently trusted channel. A public key
delivered beside an otherwise untrusted image and bundles does not establish who
signed them.

### 2. Configure the action

Only `contents: read` is needed. Reference the secret environment variable by
name; do not put private-key bytes in `signing-key`:

```yaml
jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      # Earlier steps build build/disk.qcow2.
      - uses: meigma/attest-vm-image@v1
        env:
          COSIGN_PRIVATE_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}
          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}
        with:
          disk-path: build/disk.qcow2
          signer: cosign-key
          signing-key: env://COSIGN_PRIVATE_KEY
```

Alternatively, a preceding step may materialize the encrypted key into a
runner-local file and pass that readable path as `signing-key`. The action masks
the resolved environment secrets and redacts key references from Cosign command
labels and errors.

### 3. Retain the bundles

On a passing result, upload the evidence directory using your normal private
artifact storage. `attestation-bundle-path` points to its `attestations/`
subdirectory. `attestation-url` and the manifest's `attestationUrl` field remain
unset because nothing was published.

The action explicitly configures Cosign with no Fulcio, OIDC, Rekor, or TSA
services, then checks that all three bundles contain zero transparency-log
entries. It verifies every signature and subject digest against the derived
public key before atomically exposing the bundle directory.

### 4. Verify with the independently trusted public key

Follow the key-backed procedure in
[Verify evidence and attestations](verification.md#verify-cosign-key-and-kms-bundles).
The `--insecure-ignore-tlog` flag is required because this mode intentionally
has no transparency entry; it does not disable public-key signature or subject
verification.

## Sign with a KMS or Transit key

Use this mode when the private key must remain inside a cloud KMS or Transit
service. The action accepts only the pinned locator forms below; aliases,
unversioned cloud keys, custom AWS endpoints, KMS plugins, and raw key material
fail input validation.

| Provider         | `signing-key` form                                                   | Authentication established before this action |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| AWS KMS          | `awskms:///arn:aws:kms:REGION:ACCOUNT:key/UUID`                      | AWS SDK ambient credentials                   |
| Google Cloud KMS | `gcpkms://projects/P/locations/L/keyRings/R/cryptoKeys/K/versions/N` | Application Default Credentials               |
| Azure Key Vault  | `azurekms://VAULT.vault.azure.net/KEY/VERSION`                       | Azure default credential environment          |
| HashiCorp Vault  | `hashivault://KEY`                                                   | `VAULT_ADDR` and `VAULT_TOKEN`                |
| OpenBao          | `openbao://KEY`                                                      | `BAO_ADDR` and `BAO_TOKEN`                    |

These five forms are supported by the action's URI contract and are derived from
the Cosign `v3.1.2` provider parsers. The validation and dispatch paths are
unit-tested. AWS KMS has also been field-tested with an immutable asymmetric key
and short-lived GitHub OIDC credentials. Google Cloud KMS, Azure Key Vault,
HashiCorp Vault, and OpenBao have not yet been field-tested here; do not
interpret URI support as a claim that every provider's IAM and service
configuration has been exercised.

### Authenticate in a preceding step

Do not pass cloud credentials to `attest-vm-image`. For AWS, exchange the
workflow's OIDC identity for short-lived credentials before invoking the action:

```yaml
jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: write
    steps:
      # Earlier steps build build/disk.qcow2.
      - name: Configure short-lived AWS credentials
        uses: aws-actions/configure-aws-credentials@517a711dbcd0e402f90c77e7e2f81e849156e31d # v6.2.2
        with:
          aws-region: ${{ vars.AWS_KMS_REGION }}
          role-to-assume: ${{ secrets.AWS_KMS_ROLE_ARN }}

      - uses: meigma/attest-vm-image@v1
        with:
          disk-path: build/disk.qcow2
          signer: kms
          signing-key: ${{ format('awskms:///{0}', secrets.AWS_KMS_KEY_ARN) }}
```

Scope the assumed role to the exact key ARN and only the operations the Cosign
AWS provider uses: `kms:DescribeKey`, `kms:GetPublicKey`, and `kms:Sign`. The
key must be asymmetric with `SIGN_VERIFY` usage. Restrict the AWS OIDC trust
policy to the repository and protected workflow environment or branch that
performs signing.

Other cloud providers follow the same boundary: their official authentication
action runs first, and `attest-vm-image` consumes only the resulting ambient
credential chain. Vault and OpenBao tokens must be short-lived and limited to
reading the named Transit key plus signing with it.

### Distribute the public key and retain the bundles

Export the public key from a trusted administrative environment and distribute
it independently from the image and bundles:

```bash
cosign public-key --key "$KMS_URI" > kms.pub
```

The action performs the same export into temporary runner storage, verifies all
three bundles against it, and then removes it. For Vault and OpenBao, whose URI
cannot pin a key version, it exports again after all three signatures and fails
without promoting bundles if the public-key fingerprint changed.

No Fulcio, OIDC, Rekor, or TSA service is configured for KMS signing.
`attestation-url` remains unset. Verify the retained bundles against the
independently trusted `kms.pub` using
[Verify `cosign-key` and `kms` bundles](verification.md#verify-cosign-key-and-kms-bundles).

## Troubleshooting

For the full decision path and exact diagnostic strings, see
[Troubleshoot a failed run](troubleshooting.md) and
[reference](reference.md#failure-modes). The signing-specific cases:

### Nothing was signed, and the attestation outputs are empty

Two different situations produce this. They differ in both the handoff file and
the outputs:

- **The validation result was `fail`.** A failing result is never signed. The
  action writes complete unsigned evidence, including a manifest whose result is
  `fail`, skips signing, and then fails the run; the seven standard evidence
  outputs are still populated, but `attestation-bundle-path` and
  `attestation-url` stay unset. Fix the image (or adjust `fail-on-severity`, see
  [Control what fails validation](validation-policy.md)) so the result passes.
  For why a failing result is never signed, see
  [how-it-works.md](how-it-works.md).
- **Signing itself threw.** Signing is a fail-closed abort: on any signing
  error, `evidence-manifest.json` is not written and no output is set — not even
  the seven non-attestation outputs — although the checksum manifest, reports,
  and predicate already exist. Read the run's failure message and match it
  below.

### The run failed with a plan or visibility error

If the repository is private or internal without GitHub Enterprise Cloud, or on
GitHub Enterprise Server, the attestation API rejects the push. The action
usually re-throws a named diagnostic telling you to use a public repository or
Enterprise Cloud. One real-world API rejection — the `Feature not available` /
`upgrade the billing plan` wording — is **not** translated and surfaces
unchanged; it means the **same** plan or visibility restriction. Both are
cataloged in [reference](reference.md#failure-modes). Move the image to an
eligible repository (see the matrix above).

### The run failed on a fork pull request or missing OIDC permission

Fork pull requests have no OIDC token, so `signer: github` and
`signer: sigstore-keyless` cannot run. Keyless input validation names the
missing `id-token: write` permission before any tool or disk access. Run the
signing job on same-repository pushes or same-repo pull requests and grant the
permission shown above.

### KMS signing failed after input validation

The URI shape was accepted, but Cosign could not fetch the public key or sign.
Confirm the preceding provider-authentication step succeeded, the role or token
can read and sign with the exact key, and the key is an asymmetric signing key.
KMS locators and provider error output are redacted from action failures;
inspect the provider authentication step and audit log for the specific denial.

## Related

- [Verify evidence and attestations](verification.md)
- [Control what fails validation](validation-policy.md)
- [Reference: Permissions](reference.md#permissions),
  [Attestation bundles](reference.md#attestation-bundles),
  [Outputs](reference.md#outputs)
- [How attest-vm-image works](how-it-works.md)
