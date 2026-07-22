# How to sign attestations

Switch a working unsigned run to either GitHub-published attestations or
portable bundles signed with an encrypted Cosign key.

## Prerequisites

- A workflow that already runs the action and produces evidence with
  `signer: none`. If you do not have one yet, complete
  [Getting started](getting-started.md) first.
- The action running in the **same job** that built the QCOW2 (see
  [how-it-works.md](how-it-works.md) for why this matters).
- For `signer: github`, a repository whose plan and visibility can issue
  attestations. Check the matrix below.
- For `signer: cosign-key`, Cosign `v3.1.2` on the administrator machine that
  creates the key, plus a separate trusted way to distribute `cosign.pub`.

## Choose a signing backend

| Backend      | Use it when                                               | Public service                                  |
| ------------ | --------------------------------------------------------- | ----------------------------------------------- |
| `github`     | The repository can use GitHub's attestation API.          | GitHub OIDC and the GitHub attestation API.     |
| `cosign-key` | A private repository needs portable, key-trusted bundles. | None while signing; bundles stay on the runner. |

Both modes create the same three stable bundle roles. Only `github` publishes
them and sets `attestation-url`.

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

Follow the `cosign-key` procedure in
[Verify evidence and attestations](verification.md#verify-cosign-key-bundles).
The `--insecure-ignore-tlog` flag is required because this mode intentionally
has no transparency entry; it does not disable public-key signature or subject
verification.

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

### The run failed on a fork pull request

Fork pull requests have no OIDC token, so `signer: github` cannot run. Run the
signing job on same-repository pushes or same-repo pull requests only, for
example by gating the job on the head repository matching the base repository.

### The run failed with a "not yet implemented" signer error

`sigstore-keyless` and `kms` remain later slices. Selecting either throws when
the signing step is reached on a passing result. Use `github`, `cosign-key`, or
`none` ([reference](reference.md#failure-modes)).

## Related

- [Verify evidence and attestations](verification.md)
- [Control what fails validation](validation-policy.md)
- [Reference: Permissions](reference.md#permissions),
  [Attestation bundles](reference.md#attestation-bundles),
  [Outputs](reference.md#outputs)
- [How attest-vm-image works](how-it-works.md)
