# How to verify evidence and attestations

This guide is for a consumer who received a QCOW2 image and the evidence that
`attest-vm-image` produced for it, and needs to confirm the image is the exact
one that was validated and, when signed, that the attestations are genuine.

It assumes the evidence already exists. Producing and signing attestations is
the operator task in [signing.md](signing.md).

## Prerequisites

- The image file you want to verify, for example `disk.qcow2` — the exact bytes,
  not a rebuilt copy.
- The evidence for it. You need at least one of:
  - the evidence directory the action wrote (`checksums.txt`, the evidence
    files, and, when the run was signed, `attestations/*.sigstore.json`); or
  - the attestations published to the repository that ran the action — enough on
    its own for online verification, no local bundle required.
- `sha256sum` (GNU coreutils) for the checksum manifest.
- The GitHub CLI (`gh`) with `gh attestation` support, authenticated with
  `gh auth login` or a `GH_TOKEN`. Commands here were tested with `gh` 2.94.0.
- `jq` if you want to extract predicate JSON for a downstream policy engine.

Throughout, `<owner>/<repo>` is the repository that **ran** `attest-vm-image`
and published the attestations — the image builder's repository, not
`meigma/attest-vm-image`.

## Verify the evidence checksums

`checksums.txt` covers the input disk and every unsigned evidence file, and is
compatible with `sha256sum -c`. This works for every run regardless of `signer`,
and verifying it re-checks the disk digest because the disk is the first line.
Its format and exact line order are in
[reference.md](reference.md#checksumstxt).

The action records each path exactly as it was passed, workspace-relative by
default, so run the check from the same working directory the action ran in
(usually the workspace root — not from inside `evidence/`):

```bash
sha256sum -c evidence/checksums.txt
```

Every covered file prints `<path>: OK` and the command exits `0`. A line that
prints `FAILED` means that file changed since the action sealed it; do not trust
it. The `attestations/` bundles are deliberately excluded from `checksums.txt` —
they carry their own Sigstore verification material (see
[reference.md](reference.md#checksumstxt)).

If the run was unsigned (`signer: none`), stop here — there are no attestations
to verify.

## Verify a published attestation online

Use this when the producing repository signed the run (`signer: github`) and
published its attestations. No local bundle is needed; `gh` recomputes the
digest from your local file and matches it against the repository's published
attestations.

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo>
```

To scope to the owner instead of a specific repository, use `--owner` (`--repo`
pins `owner/repo`, a tighter identity check; at least one is required):

```bash
gh attestation verify disk.qcow2 --owner <owner>
```

Pass the real image file, never a bare digest — `gh` recomputes the digest
itself, and a bare `sha256:<hex>` is rejected with
`failed to open local artifact`.

Success is exit code `0`. On an interactive terminal `gh` prints the policy
banner and a green `Verification succeeded!`. In CI, or whenever output is piped
or redirected, `gh` prints **nothing** on success — rely on the exit code
(`echo $?`) or add `--format json`:

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo> --format json
```

The command above verifies the build-provenance attestation, which uses `gh`'s
default predicate. To verify the SBOM or validation attestation instead, add
`--predicate-type`; see
[Select a specific attestation](#select-a-specific-attestation).

## Verify from the local bundle files

When you have the `attestations/` directory, verify against a bundle on disk
with `--bundle` instead of fetching from the API. The action writes each
attestation as a single Sigstore bundle in one JSON object, and
`gh attestation verify --bundle` accepts that shape directly. The bundle
filenames and their predicate types are in
[reference.md](reference.md#attestation-bundles).

There are two tiers, and the difference matters.

### Trust root from the network

`--bundle` reads the attestation from the local file but still contacts the
Sigstore and GitHub TUF services for the trust root:

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo> \
  --bundle evidence/attestations/provenance.sigstore.json
```

With all network egress blocked this fails with
`no valid Sigstore verifiers could be initialized`. For a fully offline check,
use the next tier.

### Fully air-gapped

Fetch the trust root once on a networked machine:

```bash
gh attestation trusted-root > trusted_root.jsonl
```

Then verify with zero network calls by passing `--custom-trusted-root`:

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo> \
  --bundle evidence/attestations/provenance.sigstore.json \
  --custom-trusted-root trusted_root.jsonl
```

This succeeds even behind a fully blocked network.

## Select a specific attestation

Each run produces three attestations with different predicate types. `gh`'s
default filter is SLSA build provenance, so the provenance attestation verifies
with no extra flag, but the SBOM and validation attestations require a matching
`--predicate-type` — without it verification fails with
`no attestations found with predicate type: https://slsa.dev/provenance/v1`.

Validation attestation (the run's primary claim):

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo> \
  --bundle evidence/attestations/validation.sigstore.json \
  --predicate-type https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1
```

SBOM attestation (SPDX):

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo> \
  --bundle evidence/attestations/sbom.sigstore.json \
  --predicate-type https://spdx.dev/Document/v2.3
```

The SPDX predicate type carries the SBOM's own SPDX version, so it is not a
fixed string. If this reports
`no attestations found with predicate type: <the type you passed>` (the bundle
holds an SBOM attestation, but under a different SPDX version), read the actual
type from the bundle (see
[Extract the predicate JSON](#extract-the-predicate-json-for-a-policy-engine))
and match the `https://spdx.dev/Document/` prefix rather than pinning `v2.3`. A
CycloneDX SBOM uses `https://cyclonedx.org/bom` instead. The full mapping is in
[reference.md](reference.md#attestation-bundles).

The same `--predicate-type` flag also works online (drop `--bundle`). The
offline `--bundle` form shown here is the tested path for the SBOM and
validation attestations; the online form for the custom validation predicate is
expected to work but was not live-verified.

## Extract the predicate JSON for a policy engine

The recommended way proves the signature first and emits the predicate in one
step:

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo> \
  --bundle evidence/attestations/validation.sigstore.json \
  --predicate-type https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1 \
  --format json --jq '.[].verificationResult.statement.predicate'
```

To read a bundle **without** verifying its signature — for example to discover
its `predicateType` — decode the DSSE payload with `jq`. This pure-`jq` form
needs no external `base64` tool:

```bash
jq -r '.dsseEnvelope.payload | @base64d | fromjson | .predicate' \
  evidence/attestations/validation.sigstore.json
```

Swap `.predicate` for `.predicateType` or `.subject` as needed. Field-by-field
definitions of the validation predicate are in
[predicate/vm-image-validation-v1.md](predicate/vm-image-validation-v1.md).

## Download attestations for later offline use

If you have only the image and want the bundles for archival, download them from
the API (`gh attestation download` is a public-preview subcommand in `gh`, so
its flags and output shape may change in a future `gh` release):

```bash
gh attestation download disk.qcow2 --repo <owner>/<repo>
```

This writes `./sha256:<digest>.jsonl` (JSON Lines — one bundle per line; on
Windows the colon becomes a dash: `sha256-<digest>.jsonl`). Filter to a single
predicate type server-side with `--predicate-type`:

```bash
gh attestation download disk.qcow2 --repo <owner>/<repo> \
  --predicate-type https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1
```

Verify against the downloaded file the same way as a local bundle (still needs
the trust root unless you add `--custom-trusted-root`):

```bash
gh attestation verify disk.qcow2 --repo <owner>/<repo> \
  --bundle sha256:<digest>.jsonl \
  --predicate-type https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1
```

Like `verify`, `download` needs the real image file — a bare digest is rejected.

## Troubleshooting

- `no attestations found with predicate type: https://slsa.dev/provenance/v1`,
  verifying an SBOM or validation bundle — you omitted `--predicate-type`; the
  default filter is provenance. Add the matching type.
- SBOM verify still reports
  `no attestations found with predicate type: <the type you passed>` with
  `--predicate-type` — the SPDX version differs. Read the real `predicateType`
  from the bundle and match the `https://spdx.dev/Document/` prefix.
- `no attestations found` with **no** `with predicate type:` suffix — this is
  not a `--predicate-type` mismatch (the two entries above are). It means there
  are no attestations at all for that artifact in that repository. Common
  causes: the run was unsigned (`signer: none`, or the validation result was
  `fail` — a failing result is never signed); signing was configured but the
  producing run could not publish (for example a plan or visibility restriction
  — see [Publish signed attestations](signing.md) for the plan matrix); or you
  pointed at the wrong `--repo`/`--owner`, or at a rebuilt file whose digest
  does not match the attested bytes. For diagnosing the producer side, see
  [Troubleshoot a failed run](troubleshooting.md).
- `no valid Sigstore verifiers could be initialized` — `--bundle` alone needs
  the trust root and your network is blocked. Add `--custom-trusted-root` (see
  [Fully air-gapped](#fully-air-gapped)) or restore egress to the Sigstore and
  GitHub TUF endpoints.
- `failed to open local artifact: open sha256:...: no such file or directory` —
  you passed a bare digest. Pass the real image file; `gh` recomputes the
  digest.
- The command printed nothing but exited `0` — that is success on a non-TTY.
  Check `$?` or add `--format json`.
- `sha256sum -c` prints `FAILED` or `No such file or directory` — you are in the
  wrong directory (run from where the recorded paths are relative to) or the
  file changed. See [reference.md](reference.md#checksumstxt).

## Related

- [reference.md](reference.md#attestation-bundles) — bundle filenames, predicate
  types, and subjects.
- [reference.md](reference.md#evidence-files) — every file the action writes.
- [signing.md](signing.md) — the producer side: how these attestations are made.
- [troubleshooting.md](troubleshooting.md) — producer-side diagnosis when a run
  wrote no attestations to verify (never signed, plan restriction, failed run).
- [how-it-works.md](how-it-works.md) — the evidence model and why a failing
  result is never signed.
