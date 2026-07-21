# attest-vm-image

A GitHub Action that inspects a finished QCOW2 VM disk image and produces
auditable evidence about what is inside it, then optionally signs that evidence.

Run it immediately after an image build — ideally in the same job — so the exact
bytes the builder emitted are the bytes that get inspected and attested. The
action is independent of any one builder: it accepts a QCOW2 disk from
Distrobuilder, mkosi, Packer, bootc/Image Builder, or anything else.

The action **never modifies the input image**. It validates the disk structure,
inspects the filesystem read-only inside an isolated libguestfs appliance,
generates a Software Bill of Materials (SBOM), scans that SBOM for known
vulnerabilities, runs contamination checks for state that should not ship in a
reusable image, records everything in a versioned validation predicate, and
computes immutable digests. When explicitly asked, it signs and publishes
attestations.

The resulting evidence lets a later system or a human reviewer establish which
exact artifact was evaluated, what software it contained, which policy was
applied, what passed or failed, which workflow produced the evidence, and which
identity signed it.

> **Status:** under active development. Inputs and outputs below describe the
> full interface; the evidence pipeline is being implemented in phases.

## Usage

The default `signer: none` mode writes checksums, the SBOM, the reports, and the
validation predicate without signing, and needs only `contents: read`.

```yaml
jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: meigma/attest-vm-image@v0
        with:
          disk-path: build/disk.qcow2
          signer: none
```

### Signing with `signer: github`

`signer: github` additionally signs the evidence and publishes three GitHub
attestations (build provenance, an SBOM attestation, and the custom validation
attestation) via GitHub Actions OIDC. The caller must grant the extra
permissions the action cannot grant itself:

```yaml
jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read # read the workspace
      id-token: write # mint the OIDC token that identifies the signer
      attestations: write # publish attestations to the repository
    steps:
      - uses: meigma/attest-vm-image@v0
        with:
          disk-path: build/disk.qcow2
          signer: github
```

Private and internal repositories require **GitHub Enterprise Cloud**; GitHub
Enterprise Server is **unsupported**. A failing validation result is never
signed — the unsigned evidence (including the predicate recording the failure)
is still written in full, but no attestation is issued. When the repository plan
cannot issue attestations the action fails with a diagnostic naming the missing
capability rather than downgrading.

## Inputs

| Input                 | Required | Default        | Description                                                                                            |
| --------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `disk-path`           | yes      | —              | Path to the completed QCOW2 disk image.                                                                |
| `metadata-path`       | no       | _(unset)_      | Incus metadata tarball associated with the disk image.                                                 |
| `build-manifest-path` | no       | _(unset)_      | Builder-generated manifest with source and build information.                                          |
| `output-directory`    | no       | `./evidence`   | Directory the action writes evidence files into.                                                       |
| `sbom-format`         | no       | `spdx-json`    | SBOM format: `spdx-json` or `cyclonedx-json`.                                                          |
| `fail-on-severity`    | no       | `high`         | Vulnerability threshold: `critical`, `high`, or `none` (report-only).                                  |
| `policy-path`         | no       | _(built-in)_   | Contamination-policy file; the built-in policy is used when unset.                                     |
| `signer`              | no       | `none`         | `none`, `github`, `sigstore-keyless`, `cosign-key`, or `kms`.                                          |
| `signing-key`         | no       | _(unset)_      | Key reference required by the selected backend (never raw key bytes).                                  |
| `github-token`        | no       | `github.token` | Token `signer: github` uses to push attestations; must carry `attestations: write`. Rarely overridden. |

## Outputs

| Output                      | Description                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `disk-digest`               | `sha256:<hex>` of the input QCOW2 image.                              |
| `checksums-path`            | Path to the generated `checksums.txt`.                                |
| `sbom-path`                 | Path to the generated SBOM.                                           |
| `vulnerability-report-path` | Path to the machine-readable vulnerability report.                    |
| `validation-report-path`    | Path to the human/machine-readable results summary.                   |
| `validation-predicate-path` | Path to the in-toto validation predicate JSON.                        |
| `attestation-bundle-path`   | Directory of signed attestation bundles, when `signer` is not `none`. |
| `attestation-url`           | URL of the validation attestation; set for `signer: github`.          |

## Verification

Every evidence run — any `signer`, including `none` — writes a
`sha256sum -c`-compatible `checksums.txt` covering the input disk and all
unsigned evidence files. Verify it from the directory the paths are relative to
(the workflow workspace by default):

```sh
sha256sum -c evidence/checksums.txt
```

When the run used `signer: github`, the three published attestations can be
verified independently with the GitHub CLI, which recomputes the disk digest and
checks the attestation against the repository:

```sh
gh attestation verify disk.qcow2 --repo meigma/attest-vm-image
```

`gh attestation verify` reads the attestations from GitHub, so it needs no local
bundle files; the bundles written under `attestations/` (and named by
`attestation-bundle-path`) are the same Sigstore bundles for offline archival.

### Requirements for `signer: github`

- The caller must grant `id-token: write`, `attestations: write`, and
  `contents: read` (see the usage example above). The action cannot grant these
  itself.
- Public repositories can issue attestations on any plan. **Private and internal
  repositories require GitHub Enterprise Cloud.** GitHub Enterprise Server is
  **unsupported** — the action does not fall back to another signer there.
- A failing validation result (a vulnerability threshold breach or a failed
  contamination check) is **never signed**: the full unsigned evidence is
  written, signing is skipped, and the run then fails on the failing result.
  Only images that pass validation are ever attested.

## Development

Tooling is pinned by [mise](https://mise.jdx.dev) and tasks run through
[moon](https://moonrepo.dev).

```sh
mise install         # provision the pinned toolchain (Node, moon)
moon run root:check  # the full CI gate: format-check, lint, test, check-dist, audit
```

Useful project commands:

```sh
moon run root:format   # prettier --write
moon run root:lint     # eslint
moon run root:test     # jest
moon run root:package  # rebuild dist/
```

The bundled action (`dist/index.js`) is **committed** — that is what
`action.yml` executes. After changing anything under `src/`, run
`moon run root:package` and commit the refreshed `dist/` in the same change;
CI's `check-dist` task rebuilds the bundle and fails if the committed copy is
stale.

The `audit` step runs `npm audit` at the strict `--audit-level=low` threshold
through `scripts/audit.mjs` (allowlist currently empty — any advisory fails the
gate). `package.json` carries an `overrides` block forcing `@sigstore/sign@^5`
and `@sigstore/bundle@^5` under `@actions/attest`, resolving the fixed
`@sigstore/core@^4.0.1` (GHSA-jfc7-64v2-mr8c); a unit test asserts the lockfile
resolves the patched majors so a silent regression fails in jest.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option. Upstream template code is MIT ([LICENSE.upstream](LICENSE.upstream)).
