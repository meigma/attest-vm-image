# Reference

This page is the authoritative catalog of the `attest-vm-image` interface: its
inputs and outputs, the files it writes, the permissions and runner capabilities
it requires, the built-in contamination policy, the pinned tool versions, and
every failure message it can emit. It only describes; task-oriented instructions
live in the how-to guides linked throughout.

The action is referenced as `uses: meigma/attest-vm-image@v1`.

## Inputs

Every input is a string. Only `disk-path` is required; each other input has a
default or a built-in fallback.

| Input                 | Required | Default               | Allowed values / format                                                                                                                |
| --------------------- | -------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `disk-path`           | Yes      | —                     | Filesystem path to the completed QCOW2 image.                                                                                          |
| `metadata-path`       | No       | (unset)               | Filesystem path to an Incus metadata tarball. Validated per [Metadata archive rules](#metadata-archive-rules).                         |
| `build-manifest-path` | No       | (unset)               | Filesystem path to a builder manifest file. Digested only; its contents are not parsed.                                                |
| `output-directory`    | No       | `./evidence`          | Directory the evidence files are written into.                                                                                         |
| `sbom-format`         | No       | `spdx-json`           | `spdx-json`, `cyclonedx-json`                                                                                                          |
| `fail-on-severity`    | No       | `high`                | `critical`, `high`, `none`                                                                                                             |
| `policy-path`         | No       | (unset)               | Filesystem path to a custom contamination policy JSON file. When unset, the [built-in policy](#built-in-contamination-policy) applies. |
| `signer`              | No       | `none`                | `none`, `github`, `sigstore-keyless`, `cosign-key`, `kms`                                                                              |
| `signing-key`         | No       | (unset)               | A key reference (never raw key bytes). Required only when `signer` is `cosign-key` or `kms`.                                           |
| `github-token`        | No       | `${{ github.token }}` | GitHub token used by `signer: github` to push attestations; must carry `attestations: write`.                                          |

Notes:

- `signer`: only `none` and `github` are implemented. `sigstore-keyless`,
  `cosign-key`, and `kms` pass input validation but fail closed when the signing
  step is reached (see [Failure modes](#failure-modes)).
- `github-token` is never read from an ambient `GITHUB_TOKEN` environment
  variable; it comes only from this input (whose default is
  `${{ github.token }}`).

### Input validation

Inputs are validated up front, before any tool runs. The first invalid input
fails closed with a distinct message:

| Condition                                               | Message                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `disk-path` empty or unset                              | `disk-path is required but was not provided.`                                           |
| `sbom-format` not in the allowed set                    | `sbom-format must be one of spdx-json, cyclonedx-json; got "<value>".`                  |
| `fail-on-severity` not in the allowed set               | `fail-on-severity must be one of critical, high, none; got "<value>".`                  |
| `signer` not in the allowed set                         | `signer must be one of none, github, sigstore-keyless, cosign-key, kms; got "<value>".` |
| `signer` is `cosign-key` or `kms` with no `signing-key` | `signer "<signer>" requires a signing-key reference, but none was provided.`            |
| `policy-path` set but missing or unreadable             | `policy-path "<path>" does not exist or is not readable.`                               |

Custom `policy-path` files are additionally parsed and structurally validated at
this point; those messages are cataloged under [Failure modes](#failure-modes).

## Outputs

The action defines eight outputs. Whether each is set depends on the run
outcome, of which there are three:

- **Pass** — the pipeline completes and the overall `result` is `pass`.
- **Evidence-complete fail** — the pipeline completes but `result` is `fail` (a
  vulnerability threshold breach or a failed contamination check).
- **Thrown error** — a stage aborts (fail-closed). No output is set at all, even
  though earlier evidence files may already exist on disk.

| Output                      | Format / value                                                | Set when                            |
| --------------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `disk-digest`               | `sha256:<hex>` (lowercase, colon-prefixed)                    | Pass; evidence-complete fail        |
| `checksums-path`            | Path to `checksums.txt`                                       | Pass; evidence-complete fail        |
| `sbom-path`                 | Path to the SBOM (name depends on `sbom-format`)              | Pass; evidence-complete fail        |
| `vulnerability-report-path` | Path to `vulnerability-report.json`                           | Pass; evidence-complete fail        |
| `validation-report-path`    | Path to `validation-report.json`                              | Pass; evidence-complete fail        |
| `validation-predicate-path` | Path to `validation-predicate.json`                           | Pass; evidence-complete fail        |
| `attestation-bundle-path`   | Directory of signed bundles (default `evidence/attestations`) | Pass **and** `signer` is not `none` |
| `attestation-url`           | URL of the validation attestation only                        | Pass **and** `signer` is `github`   |

Notes:

- The six non-attestation outputs are set on both a pass and an
  evidence-complete fail; none are set on any thrown error.
- `attestation-bundle-path` and `attestation-url` are set only on the pass path
  with signing. A failing result is never signed, so both remain unset even when
  `signer` is not `none`.
- `attestation-url` carries the validation attestation's URL only. The
  provenance and SBOM attestation URLs are written to the workflow log, not
  exposed as outputs.
- `sbom-path`: read this output rather than hardcoding a filename. The SBOM is
  `sbom.spdx.json` or `sbom.cyclonedx.json` depending on `sbom-format`.
- `disk-digest` is `sha256:<hex>`. The bare 64-character hex form (no `sha256:`
  prefix) is what appears inside the predicate, report, and `checksums.txt`.

## Permissions

Required job permissions by signer. The action cannot grant these; the calling
job must declare them.

| `signer` | `contents` | `id-token` | `attestations` |
| -------- | ---------- | ---------- | -------------- |
| `none`   | `read`     | —          | —              |
| `github` | `read`     | `write`    | `write`        |

Notes:

- `signer: none` needs only `contents: read`.
- `signer: github` additionally needs `id-token: write` (OIDC signing identity)
  and `attestations: write` (push to the attestation API using `github-token`).
- Plan and visibility for `signer: github`: public repositories on any plan;
  private and internal repositories require GitHub Enterprise Cloud; GitHub
  Enterprise Server is unsupported. The action hard-fails and never downgrades
  to a different signer (see [signing.md](signing.md) and
  [how-it-works.md](how-it-works.md)).
- Fork pull requests receive a read-only token and no OIDC token, so
  `signer: github` cannot run on a fork pull request.

## Requirements

- **Runtime:** the action runs on the Node 24 Actions runtime. The committed
  `dist/` executes; consumers need no Node, npm, or build tooling.
- **Runner OS and architecture:** Linux only. `x64` is the supported and tested
  target. `arm64` is best-effort: GitHub-hosted `arm64` runners have no KVM, so
  the guest-inspection tooling falls back to slow software emulation (see
  [how-it-works.md](how-it-works.md) for why). Non-Linux platforms and other
  architectures fail closed (see [Failure modes](#failure-modes)). Every
  workflow in this repository uses `runs-on: ubuntu-24.04`.
- **Privileged package install:** the action installs `qemu-utils` and
  `libguestfs-tools` itself at runtime with `sudo apt-get`, so the runner must
  permit `apt-get` and passwordless `sudo`. GitHub-hosted `ubuntu-*` runners
  qualify by default.
- **Kernel readability:** the action runs `sudo chmod +r /boot/vmlinuz-*` so the
  guest-inspection tooling can read the host kernel image as the non-root runner
  user. It fails closed if no readable `/boot/vmlinuz-*` remains.
- **Same-job pre-build steps:** a step that builds or mounts a QCOW2 with
  `libguestfs`/`qemu` **before** the action in the same job must perform this
  `apt-get install` and `chmod` itself. The action's own install runs only when
  the action runs, which is too late for a preceding step.
- **Network egress:** the action requires outbound access to:
  - `github.com` release assets — to download the pinned `syft` and `grype`
    binaries (see [Tool versions](#tool-versions)).
  - the Grype vulnerability database — downloaded at scan time.
  - the GitHub attestation API — only for `signer: github`.
- **`GRYPE_DB_CACHE_DIR`:** Grype honors this environment variable to pre-seed
  the vulnerability database on locked-down or air-gapped runners. It is not an
  action input; set it as a step- or job-level `env:` value and it passes
  through to Grype.

## Evidence files

Evidence is written under `output-directory` (default `./evidence`). Basenames
are fixed except the SBOM, whose name depends on `sbom-format`.

| File                                    | Written when                      | Description                                               |
| --------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| `checksums.txt`                         | Evidence stage reached            | `sha256sum -c`-compatible manifest (see below).           |
| `sbom.spdx.json`                        | `sbom-format` is `spdx-json`      | SPDX JSON SBOM, disk digest embedded as the subject.      |
| `sbom.cyclonedx.json`                   | `sbom-format` is `cyclonedx-json` | CycloneDX JSON SBOM, disk digest embedded as the subject. |
| `vulnerability-report.json`             | Evidence stage reached            | The raw Grype JSON report.                                |
| `validation-report.json`                | Evidence stage reached            | Flattened predicate plus `incusMetadata.properties`.      |
| `validation-predicate.json`             | Evidence stage reached            | The in-toto statement (subject + predicate).              |
| `attestations/provenance.sigstore.json` | `signer` not `none` **and** pass  | Build-provenance Sigstore bundle.                         |
| `attestations/sbom.sigstore.json`       | `signer` not `none` **and** pass  | SBOM attestation Sigstore bundle.                         |
| `attestations/validation.sigstore.json` | `signer` not `none` **and** pass  | Validation attestation Sigstore bundle.                   |

Exactly one SBOM file is written per run. The five unsigned evidence files and
`checksums.txt` are all present on both a pass and an evidence-complete fail. A
fail-closed abort partway through the pipeline may leave a partial subset (a
stage that threw wrote nothing past it) and never sets outputs; see
[Failure modes](#failure-modes) and [how-it-works.md](how-it-works.md).

`validation-report.json` differs from `validation-predicate.json` in exactly one
way: the report prepends the statement's `subject` and `predicateType` and its
`incusMetadata` carries the raw Incus `properties` object, whereas the
digest-only predicate keeps `incusMetadata` to its `sha256`. Field-by-field
definitions of the predicate live in
[predicate/vm-image-validation-v1.md](predicate/vm-image-validation-v1.md).

## checksums.txt

Format: compatible with `sha256sum -c`. One line per covered file — a lowercase
64-character hex digest, two spaces, then the path exactly as it was passed to
the action (workspace-relative by default). The verification procedure is in
[verification.md](verification.md).

Line order (exact):

1. The input disk (`disk-path`).
2. `metadata-path`, if provided.
3. `build-manifest-path`, if provided.
4. The SBOM file (`sbom.spdx.json` or `sbom.cyclonedx.json`).
5. `vulnerability-report.json`
6. `validation-report.json`
7. `validation-predicate.json`

The `attestations/` bundles are **excluded** from `checksums.txt`: they are
written after `checksums.txt` is sealed and carry their own Sigstore
verification material.

Disk re-digest guard: before writing `checksums.txt`, the action re-hashes
`disk-path` and compares it to the digest computed during disk validation. Any
difference aborts before `checksums.txt` is written (see
[Failure modes](#failure-modes): `The input disk ... changed during the run`).

## Attestation bundles

Written only when `signer` is not `none` and the result is a pass, under
`<output-directory>/attestations/`. Each file is a single Sigstore bundle stored
as one JSON object, pretty-printed. Verification commands are in
[verification.md](verification.md).

| File                       | Predicate type                                                                       | Subject(s)                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `provenance.sigstore.json` | `https://slsa.dev/provenance/v1`                                                     | The disk; plus the metadata tarball as a second subject when `metadata-path` is set. |
| `sbom.sigstore.json`       | `https://spdx.dev/Document/v<X.Y>` (SPDX) or `https://cyclonedx.org/bom` (CycloneDX) | The disk only.                                                                       |
| `validation.sigstore.json` | `https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1`          | The disk only.                                                                       |

Notes:

- The SPDX predicate type is derived at runtime from the SBOM's own
  `spdxVersion` field (for example `SPDX-2.3` yields `.../Document/v2.3`),
  defaulting to `v2.3` when the field is absent or malformed. Match on the
  `https://spdx.dev/Document/` prefix rather than pinning an exact version.
- `provenance.sigstore.json` uses the SLSA build-provenance type, which is the
  default predicate for `gh attestation verify` (it verifies without
  `--predicate-type`). The other two are non-provenance predicates and must be
  selected with `--predicate-type`.
- The metadata tarball is a subject of the provenance attestation only, never of
  the SBOM or validation attestations.
- `attestation-url` points at the validation attestation.
- The validation predicate type is an opaque, versioned identifier and is not a
  live endpoint. Field-by-field definitions:
  [predicate/vm-image-validation-v1.md](predicate/vm-image-validation-v1.md).

## Metadata archive rules

Applies when `metadata-path` is set. The tarball is validated entry by entry
**before** extraction; any violation is a fail-closed abort. Compression is
auto-detected.

Required:

- A `metadata.yaml` at the archive root.
- `metadata.yaml` must contain the fields `architecture` and `creation_date`.

Only regular files, directories, symlinks, and hardlinks are kept. Every other
condition is rejected with a distinct message (see
[Failure modes](#failure-modes)):

- device nodes, FIFOs, and any unrecognized tar entry type
- absolute paths
- `..` parent-directory traversal
- symlink targets that escape the extraction root
- hardlink targets that escape the extraction root
- an entry whose parent path component is itself a declared symlink (a
  symlink-chain escape)

The raw Incus `properties` object is recorded in `validation-report.json` only;
`validation-predicate.json` keeps `incusMetadata` to its digest.

## Built-in contamination policy

Policy id `builtin/v1`. It applies whenever `policy-path` is unset. A custom
`policy-path` **fully replaces** this set (there is no merge); the matcher field
shapes and the procedure for extending the built-in rules are documented in
[validation-policy.md](validation-policy.md). The built-in policy carries no
`sha256` in the predicate; a custom policy's file digest is recorded in
`policy.sha256`.

The block below reproduces `builtin/v1` exactly and is a valid custom-policy
starting point.

```json
{
  "id": "builtin/v1",
  "rules": [
    {
      "id": "no-runner-credentials",
      "title": "GitHub Actions runner registration credentials are absent",
      "matcher": {
        "type": "path-glob",
        "glob": "**/actions-runner/.credentials*"
      }
    },
    {
      "id": "no-runner-registration",
      "title": "GitHub Actions runner registration state is absent",
      "matcher": { "type": "path-glob", "glob": "**/actions-runner/.runner" }
    },
    {
      "id": "no-ssh-private-keys",
      "title": "SSH private keys are absent from home directories",
      "matcher": {
        "type": "path-glob",
        "glob": "/{root,home}/**/.ssh/id_{rsa,dsa,ecdsa,ed25519}"
      }
    },
    {
      "id": "no-pem-private-keys",
      "title": "PEM private-key files are absent from home directories",
      "matcher": { "type": "path-glob", "glob": "/{root,home}/**/*.pem" }
    },
    {
      "id": "no-ssh-host-keys",
      "title": "Persisted SSH host keys are absent",
      "matcher": { "type": "path-glob", "glob": "/etc/ssh/ssh_host_*_key*" }
    },
    {
      "id": "no-machine-id",
      "title": "Machine identity is cleared for regeneration",
      "matcher": { "type": "non-empty-file", "path": "/etc/machine-id" }
    },
    {
      "id": "no-dbus-machine-id",
      "title": "D-Bus machine identity is cleared for regeneration",
      "matcher": {
        "type": "non-empty-file",
        "path": "/var/lib/dbus/machine-id"
      }
    },
    {
      "id": "no-cloud-init-instance",
      "title": "Cloud-init instance state is absent",
      "matcher": { "type": "path-exists", "path": "/var/lib/cloud/instance" }
    },
    {
      "id": "no-cloud-init-instances",
      "title": "Cloud-init per-instance data directory is absent",
      "matcher": { "type": "path-exists", "path": "/var/lib/cloud/instances" }
    },
    {
      "id": "no-apt-auth-conf",
      "title": "APT authentication credentials are absent",
      "matcher": { "type": "path-exists", "path": "/etc/apt/auth.conf" }
    },
    {
      "id": "no-apt-auth-conf-d",
      "title": "APT auth.conf.d credential fragments are absent",
      "matcher": { "type": "path-glob", "glob": "/etc/apt/auth.conf.d/*" }
    },
    {
      "id": "no-netrc-credentials",
      "title": "netrc credential files are absent from home directories",
      "matcher": { "type": "path-glob", "glob": "/{root,home}/**/.netrc" }
    },
    {
      "id": "no-build-temp-files",
      "title": "Build temporary files are absent from /tmp",
      "matcher": {
        "type": "path-glob",
        "glob": "/tmp/**",
        "exclude": [
          "/tmp/.X11-unix",
          "/tmp/.ICE-unix",
          "/tmp/.font-unix",
          "/tmp/.XIM-unix",
          "/tmp/.Test-unix",
          "/tmp/systemd-private-*"
        ]
      }
    },
    {
      "id": "no-root-shell-history",
      "title": "root's shell history is absent",
      "matcher": { "type": "path-exists", "path": "/root/.bash_history" }
    },
    {
      "id": "no-root-password",
      "title": "root has no set password in /etc/shadow",
      "matcher": {
        "type": "content-regex",
        "path": "/etc/shadow",
        "pattern": "^root:[^*!:]"
      }
    }
  ]
}
```

Each rule evaluates read-only against the mounted guest filesystem and produces
one of three statuses: `pass` (matcher did not hit), `fail` (matcher hit), or
`skip` (matcher could not be evaluated). Only a `fail` status affects the
overall result; a `skip` never fails the run.

## Tool versions

The predicate's `tools` array records name/version pairs. The array is
informational; its length and order are not guaranteed stable across patch
releases. As produced, the order is `syft`, `grype`, the `apt`-installed
packages, then the action itself.

| Tool               | Version               | Source                                | Integrity                                                           |
| ------------------ | --------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `syft`             | `1.48.0`              | GitHub Release binary (anchore/syft)  | Pinned per-platform SHA-256, verified before extraction or caching. |
| `grype`            | `0.116.0`             | GitHub Release binary (anchore/grype) | Pinned per-platform SHA-256, verified before extraction or caching. |
| `qemu-utils`       | Ubuntu archive build  | `sudo apt-get install`                | Unpinned; the installed version is recorded via `dpkg-query`.       |
| `libguestfs-tools` | Ubuntu archive build  | `sudo apt-get install`                | Unpinned; the installed version is recorded via `dpkg-query`.       |
| `attest-vm-image`  | This action's version | `package.json`                        | Appended last.                                                      |

Notes:

- `syft` and `grype` are byte-pinned: a download whose SHA-256 does not match
  the pin aborts before extraction or caching (see
  [Failure modes](#failure-modes)).
- `qemu-utils` and `libguestfs-tools` carry no version pin; the action installs
  whatever the runner's Ubuntu archive provides and records the `dpkg` package
  names (`qemu-utils`, `libguestfs-tools`), not the binary names.

## Failure modes

The action fails in two distinct ways:

- **Fail-closed abort** — a stage throws before the evidence is complete. The
  run fails with the thrown message and **no output is set**. Evidence on disk
  may be partial or absent.
- **Evidence-complete failure** — the pipeline runs to completion but the
  overall `result` is `fail`. All six standard outputs are set, all evidence
  files are written, and only then does the run fail. Its message is cataloged
  at the end of this section.

Signing failures are fail-closed aborts that occur after `checksums.txt` is
sealed: complete unsigned evidence exists on disk, but no output is set. The
reasoning behind the two taxonomies is in [how-it-works.md](how-it-works.md);
the operational decision path is in [troubleshooting.md](troubleshooting.md).

Placeholders written as `<...>` are interpolated at runtime.

### Input validation

- `disk-path is required but was not provided.` — the `disk-path` input was
  empty. Provide the path to the completed QCOW2 image.
- `sbom-format must be one of spdx-json, cyclonedx-json; got "<value>".` —
  invalid `sbom-format`. Use `spdx-json` or `cyclonedx-json`.
- `fail-on-severity must be one of critical, high, none; got "<value>".` —
  invalid `fail-on-severity`. Use `critical`, `high`, or `none`.
- `signer must be one of none, github, sigstore-keyless, cosign-key, kms; got "<value>".`
  — invalid `signer`. Use one of the listed values.
- `signer "<signer>" requires a signing-key reference, but none was provided.` —
  `cosign-key` or `kms` was selected without `signing-key`. Provide a
  `signing-key` reference, or select a supported signer (`none`/`github`).
- `policy-path "<path>" does not exist or is not readable.` — the `policy-path`
  file is missing or unreadable. Point it at a readable file.

### Disk validation

- `Disk path "<path>" does not exist.` — `disk-path` points at nothing. Check
  the path.
- `Disk path "<path>" is not a regular file.` — the path is a directory, device,
  or other non-file. Point at the QCOW2 file.
- `Disk "<path>" is not a QCOW2 image: qemu-img reports format "<format>". Only qcow2 is supported.`
  — the input is not QCOW2. Produce or convert to `qcow2`.
- `Disk "<path>" has an unexpected backing file "<name>"; backing files are not supported in v1.`
  — the image has a backing chain. Flatten it (for example with
  `qemu-img convert`).
- `Disk "<path>" failed the qemu-img integrity check: <n> corruption(s), <n> check error(s), exit code <n>. The image is corrupt.`
  — structural corruption. Rebuild the image.

### Filesystem inspection

- `No operating system detected in "<path>"; libguestfs found no root filesystem.`
  — no OS root was found. Verify the image contains an installed OS.
- `Multiple operating systems detected in "<path>" (<roots>); multi-boot images are not supported.`
  — more than one OS root. Provide a single-OS image.
- `Could not read /etc/os-release from "<path>"; the guest filesystem could not be fully inspected.`
  — `/etc/os-release` is missing or unreadable. Ensure the guest ships it.
- `The package database cannot be enumerated for "<path>"; refusing to emit an empty package inventory.`
  — no installed packages were found. Verify the image is a real,
  package-managed OS.

### Metadata archive

- `Unsafe archive entry "<name>": device nodes are not allowed.`
- `Unsafe archive entry "<name>": FIFOs are not allowed.`
- `Unsafe archive entry "<name>": unsupported file type "<type>".`
- `Unsafe archive entry "<name>": absolute paths are not allowed.`
- `Unsafe archive entry "<name>": parent-directory ("..") traversal is not allowed.`
- `Unsafe archive entry "<name>": a parent path component "<prefix>" is a symlink, which could redirect extraction outside the root.`
- `Unsafe archive entry "<name>": symlink target "<target>" escapes the extraction root.`
- `Unsafe archive entry "<name>": hardlink target "<target>" escapes the extraction root.`
- `Unparseable tar listing line: "<line>".`

  Cause for all of the above: the metadata tarball contains an unsafe or
  unparseable entry. Remedy: rebuild the tarball with only regular files,
  directories, and in-root symlinks/hardlinks.

- `Archive "<path>" does not contain a metadata.yaml at its root.` — add a
  `metadata.yaml` at the archive root.
- `metadata.yaml in "<path>" is missing the required field "<field>".` — add the
  named field (`architecture` or `creation_date`) to `metadata.yaml`.

### SBOM generation

- `Syft failed to generate an SBOM (exit code <n>) for "<mountPath>".` — Syft
  exited non-zero (its stderr is appended when present). Inspect the appended
  output.
- `Syft produced an SBOM with zero packages; refusing to emit an empty component inventory.`
  (SPDX) — no real packages were found. Verify the image is package-managed.
- `Syft produced an SBOM with zero components; refusing to emit an empty component inventory.`
  (CycloneDX) — as above, for CycloneDX output.
- `Could not embed the disk digest into the SPDX SBOM: no package matched the document DESCRIBES relationship.`
  — the generated SPDX document had no described package to stamp. Rebuild with
  a supported Syft version.

### Vulnerability scan

A scan error aborts the run with no report written and is distinct from a
threshold breach. A threshold breach does **not** appear here — it completes the
evidence and becomes an evidence-complete failure (see below).

- `Grype vulnerability scan failed (exit code <n>) for "<sbomPath>"; recording no vulnerability verdict.`
  — Grype exited non-zero (its stderr is appended when present).
- `Grype produced no output scanning "<sbomPath>"; recording no vulnerability verdict.`
  — Grype emitted nothing.
- `Grype produced unparseable output scanning "<sbomPath>"; recording no vulnerability verdict.`
  — Grype output was not valid JSON.

  Remedy for all three: retry; if it persists, check network access to the Grype
  vulnerability database (see [Requirements](#requirements)).

### Contamination policy

Emitted when loading a custom `policy-path` file:

- `Contamination policy "<path>" is not valid JSON.`
- `Contamination policy "<path>" must be a JSON object.`
- `Contamination policy "<path>" is missing a string "id".`
- `Contamination policy "<path>" is missing a "rules" array.`
- `Rule at index <index> in policy "<path>" is not an object.`
- `Rule at index <index> in policy "<path>" is missing a string "id".`
- `Rule "<id>" in policy "<path>" is missing a string "title".`
- `Rule "<id>" in policy "<path>" has no matcher object.`
- `Rule "<id>" in policy "<path>" has a matcher missing the string field "<field>".`
- `Rule "<id>" in policy "<path>" has a matcher field "exclude" that must be an array of strings.`
- `Rule "<id>" in policy "<path>" has an unknown matcher type "<type>".`

  Cause: the custom policy file is malformed or uses an unknown matcher shape.
  Remedy: correct the named rule/field against the shapes in
  [validation-policy.md](validation-policy.md).

### Tool acquisition and platform

Tool acquisition runs before the disk is validated, so these can precede a
disk-path error.

- `Integrity check failed for <name> <version> (<platform>): expected sha256 <expected>, got <actual>. Refusing to extract or cache the download.`
  — a downloaded `syft`/`grype` binary did not match its pinned digest. Retry
  (the download may be corrupt); a persistent mismatch is a supply-chain signal.
- `No readable kernel image at /boot/vmlinuz-* after chmod. The libguestfs direct backend supermin appliance must read the host kernel image as the non-root runner user; without it guestmount fails.`
  — no readable host kernel remained. Use a runner whose `/boot/vmlinuz-*` can
  be made world-readable (see [Requirements](#requirements)).
- `attest-vm-image runs only on Linux runners; detected platform "<platform>". Use an ubuntu-* runner.`
  — non-Linux runner. Use an `ubuntu-*` runner.
- `attest-vm-image supports only x64 and arm64 Linux runners; detected architecture "<arch>".`
  — unsupported architecture. Use an `x64` (or best-effort `arm64`) Linux
  runner.

### Checksums

- `The input disk "<path>" changed during the run: expected sha256 <expected>, re-digested <actual>. The image must never be modified; refusing to seal checksums.`
  — the disk file changed between validation and sealing. Ensure no other step
  writes to `disk-path` while the action runs.

### Signing

Signing runs only for `signer: github` on a passing result.

- `signer: github requires a GitHub token to push attestations to the GitHub attestation API. Provide the github-token input (it defaults to the job's ${{ github.token }} and must carry attestations: write), but it resolved empty.`
  — `github-token` resolved empty. Do not override it with an empty value; the
  default carries the job token.
- `this repository's plan cannot issue attestations; signer: github requires a public repository or GitHub Enterprise Cloud (GitHub Enterprise Server is unsupported), and the caller must grant permissions id-token: write + attestations: write. Underlying error: <underlying message>`
  — the translated plan/visibility diagnostic. It fires when the attestation-API
  rejection text matches one of `forbidden`, `not found`, `not accessible`, or
  `advanced security`. Remedy: use a public repository or GitHub Enterprise
  Cloud, and grant the permissions above.
- `Failed to persist attestation: <... Feature not available ... upgrade the billing plan ...>`
  — the **raw, untranslated** attestation-API rejection. This billing-plan
  wording is not matched by the classifier above, so it surfaces unchanged. It
  indicates the **same** plan/visibility restriction as the translated
  diagnostic. Remedy: identical — use a public repository or GitHub Enterprise
  Cloud.
- `signer "<signer>" is not yet implemented. v1 supports only "none" and "github"; the external backends (sigstore-keyless, cosign-key, kms) are a post-v1 extension point, and this action never falls back to a different backend.`
  — `sigstore-keyless`, `cosign-key`, or `kms` was selected and reached (this
  throws only on a passing result; a failing result skips signing). Remedy: use
  `none` or `github`.

### Evidence-complete failure

This is not an abort. All evidence and all six standard outputs are set, signing
is skipped, and the run then fails.

- `Validation result is "fail"; complete evidence was written to "<output-directory>". Reason: <reasons>.`

  `<reasons>` is a `; `-joined list drawn from:

  - `vulnerability findings at or above the "<threshold>" threshold`
  - `<n> contamination check(s) failed (<id>, <id>, ...)`

  Cause: a vulnerability threshold breach and/or one or more failed
  contamination checks. Remedy: fix the image, or — for vulnerabilities — adjust
  `fail-on-severity` per [validation-policy.md](validation-policy.md).
