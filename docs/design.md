# Design: `attest-vm-image`

## Purpose and scope

`attest-vm-image` is a GitHub Action that inspects a finished Linux VM disk
image, produces auditable evidence about what is inside it, and optionally signs
that evidence. It is meant to run immediately after an image build — ideally in
the same job — so that the exact bytes the builder emitted are the bytes that
get inspected and attested. The action is independent of any one builder: it
accepts a QCOW2 disk from Distrobuilder, mkosi, Packer, bootc/Image Builder, or
anything else.

The driving use case is a workflow that builds an Incus-compatible GitHub runner
image and hands the resulting QCOW2 to this action. The action validates the
disk structure, inspects the filesystem read-only, produces an SBOM, scans that
SBOM for known vulnerabilities, runs contamination checks for state that should
not be baked into a reusable image, records everything in a versioned validation
predicate, computes immutable digests, and — only when explicitly asked — signs
and publishes attestations. The resulting evidence lets a later system or a
human reviewer establish:

- Which exact artifact was evaluated.
- What software was installed.
- Which validation policy was applied.
- What passed or failed.
- Which workflow produced the evidence.
- Which identity signed it.

Scope is deliberately narrow. The action **never modifies the input image** and
does not build, remediate, boot-test, or import it; it does not publish a GitHub
Release, upload or promote an Incus alias, or register a runner; it does not
decide whether a given CVE is operationally acceptable, guarantee bit-for-bit
reproducibility, or ever choose a signing trust model on the caller's behalf.
Boot testing and production promotion remain separate workflow stages with their
own permissions.

## Terms

Definitions used throughout this document, grounded once here so later uses need
no aside:

- **SBOM** — Software Bill of Materials: a machine-readable inventory of every
  package in an artifact.
- **in-toto** — a supply-chain attestation specification. An in-toto
  **statement** is a JSON document binding a typed **predicate** (a set of
  claims) to a **subject** artifact identified by digest.
- **Validation predicate** — this action's own predicate type: a versioned JSON
  document of claims about the inspected image (see
  [Validation predicate](#validation-predicate)).
- **Attestation** — a signed statement binding a predicate to an artifact
  digest.
- **Provenance** — an attestation describing how, where, and by whom an artifact
  was produced (a SLSA-format predicate).
- **Transparency log** — a public append-only ledger (Rekor) that records
  signatures for independent audit.
- **Keyless signing** — signing where each run gets a short-lived certificate
  tied to the workflow's OIDC identity instead of a long-lived private key.

## Form of the action

**Decision: keep the repository's TypeScript-action form.** The action stays a
Node 24 ESM action (`runs: { using: node24, main: dist/index.js }`) that
orchestrates the external tools as child processes through `@actions/exec`, and
uses the `@actions/attest` toolkit library directly for the `github` signer
rather than nesting the `actions/attest` action.

The product spec suggests a composite action, but that recommendation predates
this repository. The repo already provides a Rollup-bundled committed `dist/`, a
Jest ESM test harness with the `__fixtures__` mocking idiom, the
`moon run root:check` CI gate, a mise-pinned dev toolchain, and release-please
automation. The pipeline here is not a thin sequence of shell steps: it involves
untrusted-archive parsing, digest bookkeeping, guaranteed cleanup on failure,
and structured predicate assembly. That logic is far easier to make correct and
to unit-test in TypeScript than in composite YAML, where fail-closed cleanup and
tar-safety checks are error-prone and effectively untestable. Running each tool
as a labelled child process (grouped with `core.startGroup`) keeps the stages
just as visible in the workflow log as composite steps would be. For the
`github` signer, a node action cannot cleanly invoke another action mid-run, so
we call the same library that powers `actions/attest` (`attest`,
`attestProvenance`) and keep a single bundled artifact we fully control.
Abandoning the TypeScript form would throw away the template's entire test,
bundle, and release machinery for no compensating benefit.

New runtime dependencies (`@actions/exec`, `@actions/tool-cache`,
`@actions/glob`, `@actions/attest`) are added to `package.json` and bundled into
`dist/index.js`. The dist rule is unchanged: whenever `src/` changes, run
`moon run root:package` and commit the refreshed `dist/` in the same change, or
`check-dist` fails CI.

### Proposed repository layout

- `src/index.ts` — entrypoint; calls `run()` (shape unchanged from template).
- `src/main.ts` — orchestrator: parse inputs, run stages in order, register
  cleanup, set outputs, `core.setFailed` on any error.
- `src/inputs.ts` — input parsing, validation, and defaults.
- `src/tools.ts` — runtime tool acquisition and integrity verification (pins).
- `src/exec.ts` — thin `@actions/exec` wrapper that captures stdout/exit code.
- `src/disk.ts` — `qemu-img` format detection and structural checks.
- `src/inspect.ts` — libguestfs read-only mount, OS detection, package
  inventory; owns the filesystem view every later stage reads.
- `src/metadata.ts` — Incus tar validation and `metadata.yaml` checks.
- `src/sbom.ts` — Syft SBOM generation.
- `src/vuln.ts` — Grype scan and severity-threshold evaluation.
- `src/contamination.ts` — contamination policy load, matching, and checks.
- `src/hash.ts` — `sha256File`/`sha256Buffer` digest helpers, used everywhere a
  file or buffer digest is needed.
- `src/checksums.ts` — `checksums.txt` assembly and the pre/post re-digest
  guard.
- `src/predicate.ts` — in-toto statement and validation-predicate assembly.
- `src/context.ts` — GitHub Actions environment/context capture.
- `src/cleanup.ts` — deferred-cleanup registry, drained in a `finally` block.
- `src/sign/index.ts` — `Signer` interface and backend dispatch; the single
  post-v1 extension point.
- `src/sign/github.ts` — `@actions/attest` integration (v1).

## Interface

### Inputs

| Input                 | Required | Default        | Description                                                               |
| --------------------- | -------- | -------------- | ------------------------------------------------------------------------- |
| `disk-path`           | yes      | —              | Path to the completed QCOW2 disk image.                                   |
| `metadata-path`       | no       | _(unset)_      | Incus metadata tarball associated with the disk.                          |
| `build-manifest-path` | no       | _(unset)_      | Builder-generated manifest with source and build information.             |
| `output-directory`    | no       | `./evidence`   | Directory the action writes evidence files into.                          |
| `sbom-format`         | no       | `spdx-json`    | `spdx-json` or `cyclonedx-json`.                                          |
| `fail-on-severity`    | no       | `high`         | Vulnerability threshold: `critical`, `high`, or `none` (report-only).     |
| `policy-path`         | no       | _(built-in)_   | Contamination-policy file; built-in policy used when unset.               |
| `signer`              | no       | `none`         | `none`, `github`, `sigstore-keyless`, `cosign-key`, or `kms`.             |
| `signing-key`         | no       | _(unset)_      | Key **reference** required by the selected backend (never raw key bytes). |
| `github-token`        | no       | `github.token` | Token the `github` signer uses to push attestations to GitHub's API.      |

Defaults are conservative: `signer` defaults to `none` and never to an automatic
backend. `fail-on-severity` defaults to `high` (fails on high and critical
findings); set it to `none` for report-only runs — the threshold is the
consumer's policy choice, not a per-CVE judgement by the action.

### Outputs

| Output                      | Description                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `disk-digest`               | `sha256:<hex>` of the input QCOW2.                                    |
| `checksums-path`            | Path to `checksums.txt`.                                              |
| `sbom-path`                 | Path to the generated SBOM.                                           |
| `vulnerability-report-path` | Path to the machine-readable vulnerability report.                    |
| `validation-report-path`    | Path to the human/machine-readable results summary.                   |
| `validation-predicate-path` | Path to the in-toto validation predicate JSON.                        |
| `attestation-bundle-path`   | Directory of signed attestation bundles, when `signer` is not `none`. |
| `attestation-url`           | URL of the validation attestation; always set for `signer: github`.   |

## Pipeline

Stages run in a fixed order. Each consumes the outputs of earlier stages and
writes into `output-directory`. Any stage that cannot complete cleanly fails the
whole action rather than emitting partial evidence — this is the fail-closed
rule. Cleanup (see [Error handling](#error-handling)) always runs. Each digest
and property the predicate needs is produced by the stage named below and stored
on a shared `state` object (see
[Where each field comes from](#where-each-field-comes-from)).

1. **Parse inputs** (`src/inputs.ts`). Validate values and resolve defaults.
   _Fails when_ `disk-path` is missing,
   `signer`/`sbom-format`/`fail-on-severity` is not an allowed value, a backend
   needs `signing-key` and none is given, or `policy-path` is set but unreadable
   or malformed.

2. **Validate the QCOW2 disk** (`src/disk.ts`). Confirm the path exists and is a
   regular file; run `qemu-img info --output=json` and confirm the detected
   format is `qcow2`; run `qemu-img check` for structural integrity; record
   virtual size, actual size, compatibility level, and relevant QCOW2 metadata.
   Returns the input's SHA-256 (stored as `state.disk.sha256`, re-verified in
   stage 9). _Fails when_ the file is missing/irregular, the format is not
   QCOW2, the integrity check reports corruption, or the image carries an
   unexpected backing file (not supported in v1).

3. **Inspect the filesystem** (`src/inspect.ts`). Open the disk **read-only** in
   libguestfs and mount its root read-only into a fresh temp directory using the
   libguestfs FUSE mount (`guestmount`, `LIBGUESTFS_BACKEND=direct`), so the
   untrusted filesystem is parsed by the isolated appliance kernel and served
   over FUSE, never mounted by the runner's host kernel. Register the handle and
   unmount on the cleanup registry. Detect the OS and root filesystem, read
   `/etc/os-release`, and inventory installed OS packages. Returns a single
   `fsView` object `{ operatingSystem, packages, mountPath }` that stages 5 and
   7 both read — there is exactly one mount for the run. _Fails when_ the root
   filesystem or package database cannot be enumerated completely.

4. **Validate Incus metadata** (`src/metadata.ts`), when `metadata-path` is set.
   Inspect the tar archive **before** extraction, reject unsafe entries, confirm
   `metadata.yaml` is present, validate required Incus fields, and record the
   metadata properties. Returns `{ sha256, properties }`. _Fails when_ the
   archive is malformed, contains an unsafe entry, or is missing required
   fields.

5. **Generate the SBOM** (`src/sbom.ts`). Run Syft against `fsView.mountPath`
   (the mounted image filesystem, a directory source — not the source repo) and
   emit `spdx-json` or `cyclonedx-json`. The SBOM records the QCOW2 sha256 as
   its subject; Syft's directory source cannot stamp an arbitrary subject digest
   itself, so `sbom.ts` post-processes the emitted document to insert it (SPDX:
   a checksum on the described root element; CycloneDX: a hash on
   `metadata.component`) before the SBOM file's own digest is computed. Returns
   `{ path, format, sha256 }`. _Fails when_ Syft errors or produces no
   components.

6. **Scan for vulnerabilities** (`src/vuln.ts`). Run Grype against the generated
   SBOM, record scanner and vulnerability-database versions, and compare the
   highest finding to `fail-on-severity`. Returns
   `{ path, sha256, scanner, dbVersion, summary, thresholdExceeded }`. _Fails
   when_ the scan itself fails (see [Error handling](#error-handling)); a
   completed scan whose findings exceed the threshold is a **threshold failure**
   recorded in the predicate, not a scan error.

7. **Run contamination checks** (`src/contamination.ts`). Reading
   `fsView.mountPath`, apply the built-in policy (or `policy-path`) for state
   that should not ship in a reusable image: runner registration credentials,
   private keys and obvious credential files, persisted SSH host keys, non-empty
   machine identity where regeneration is expected, cloud-init instance state,
   package-manager/provisioning credentials, and build temp files in configured
   sensitive locations. Each check yields pass/fail/skip. These are safety
   signals, not a claim of comprehensive secret detection.

8. **Assemble the predicate and report** (`src/predicate.ts`). Combine all
   `state` results into the versioned validation predicate and a human-readable
   `validation-report.json`, computing the overall pass/fail result.

9. **Compute checksums** (`src/checksums.ts`). Write a `sha256sum`-compatible
   `checksums.txt` covering the disk, optional metadata and build manifest, and
   every unsigned evidence file. Attestation bundles are **not** covered: they
   are written by stage 10 after `checksums.txt` is sealed, and Sigstore bundles
   carry their own verification material. Re-digest the input disk and assert it
   equals `state.disk.sha256` from stage 2. _Fails when_ the input digest
   changed.

10. **Sign** (`src/sign/*`), only when `signer` is not `none` **and** the
    predicate's `result` is `pass`. Produce build provenance, an SBOM
    attestation, and a custom validation attestation, and write bundles into
    `attestations/`. _Fails when_ the backend's prerequisites are missing; it
    never falls back to another backend.

A threshold breach (stage 6) or any failing contamination check (stage 7)
produces **complete** evidence, sets `result: "fail"` in the predicate, and
fails the action after evidence is written — distinct from the fail-closed
aborts, which stop before evidence exists. A failing result is never signed:
stage 10 is skipped when `result` is `fail`, so attestations are only ever
issued for images that passed validation. The unsigned evidence — including the
predicate recording the failure — is still written in full for audit.

## Evidence output layout

Written under `output-directory` (default `./evidence`):

```text
checksums.txt                 # sha256sum -c compatible; covers inputs + all unsigned evidence below (not attestations/)
sbom.spdx.json                # or sbom.cyclonedx.json, per sbom-format
vulnerability-report.json     # Grype JSON, with scanner + DB versions
validation-report.json        # human/machine summary of every check
validation-predicate.json     # in-toto statement wrapping the validation predicate
attestations/                 # only when signer != none and result is pass
  provenance.sigstore.json    # build-provenance attestation bundle
  sbom.sigstore.json          # SBOM attestation bundle
  validation.sigstore.json    # custom validation attestation bundle
```

The default directory is `./evidence` (not `./attestations`) so the
signed-bundle subdirectory `attestations/` does not double up on the parent
name. The input disk is never copied here; `checksums.txt` references it by path
and digest.

## External tools and runtime acquisition

The action shells out to four external tools. mise pins only the **development**
toolchain — it is not present on a consumer's runner — so the action must
acquire and integrity-verify these tools itself at run time. Primary target is
GitHub-hosted `ubuntu-24.04` (x64). Tool pins also carry `linux-arm64` digests,
but GitHub-hosted arm64 runners expose no KVM, so the libguestfs appliance falls
back to TCG software emulation there — functional but much slower; arm64 is
best-effort, x64 is the supported target.

| Tool               | Purpose                         | Acquisition on the runner                                                    |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------- |
| `qemu-img`         | QCOW2 format + integrity checks | `apt-get install` `qemu-utils` from Ubuntu's signed archive.                 |
| `libguestfs-tools` | Read-only filesystem inspection | `apt-get install` from Ubuntu's signed archive; `LIBGUESTFS_BACKEND=direct`. |
| `syft`             | SBOM generation                 | Download pinned release binary from GitHub Releases.                         |
| `grype`            | Vulnerability scan              | Download pinned release binary from GitHub Releases.                         |

**apt packages** (`qemu-utils`, `libguestfs-tools`) are verified by apt against
Ubuntu's signed archive keyring, which is the runner's existing trust root. The
action does not assert a pre-chosen version — Ubuntu's archive generally carries
only the current build, so it installs whatever the pinned `ubuntu-24.04` image
provides and records the **actually installed** version (via `dpkg-query`) in
the predicate after the fact. It fails if the install fails. libguestfs runs its
filesystem drivers inside a lightweight isolated appliance (direct backend,
using the KVM available on GitHub-hosted Linux runners) rather than mounting the
untrusted filesystem into the host kernel.

One runner-specific fixup is required: the direct backend builds its appliance
with supermin, which must read the host kernel image, and Ubuntu ships
`/boot/vmlinuz-*` readable only by root while the action runs as the non-root
`runner` user. After installing the apt packages, tool setup runs
`sudo chmod +r /boot/vmlinuz-*` and fails closed if no readable kernel remains —
otherwise the first `guestmount` would fail with supermin's unreadable-kernel
error.

**Standalone binaries** (`syft`, `grype`) are pinned in `src/tools.ts` by exact
version and per-platform SHA-256 digest. `@actions/tool-cache` downloads the
release asset from the pinned URL, the action recomputes the SHA-256 and
compares it to the pinned digest, and **aborts on any mismatch** before running
the tool; a matching download is cached. Anchore also publishes cosign
signatures for these releases, so cosign verification of the checksums file can
be layered on as a hardening step. Pinned versions and digests are bumped by
Dependabot-style PRs and reviewed like any other dependency change.

Grype downloads a vulnerability database at scan time; the action records the DB
schema version and build timestamp in the report and honors a cache directory so
the DB can be pre-seeded for locked-down runners.

## Validation predicate

The predicate is the typed payload of an in-toto **statement**. Its predicate
type is a project-owned, versioned URI:

```text
https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1
```

This URI is an **opaque, versioned identifier** — in-toto predicate types need
not be fetchable, and this action stands up no GitHub Pages site to serve it.
The schema is documented **in-repo**: the human-readable schema at
`docs/predicate/vm-image-validation-v1.md` and the machine-readable JSON Schema
at `docs/predicate/vm-image-validation-v1.schema.json`, whose `$id` field equals
the URI above verbatim (asserted by a unit test). Reviewers read it at its
GitHub blob URL; no live-resolving endpoint is claimed or required. A breaking
change mints a `v2` URI and a new schema pair; older versions are retained.

Schema sketch (fields abbreviated; shown compact — this is a sketch, not the
canonical JSON Schema):

```text
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "disk.qcow2", "digest": { "sha256": "<hex>" } }],
  "predicateType": "https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1",
  "predicate": {
    "schemaVersion": "1",
    "artifact": { "name": "disk.qcow2", "sizeBytes": 0, "sha256": "<hex>" },
    "incusMetadata": { "sha256": "<hex>" } | null,   // null when not provided
    "buildManifest": { "sha256": "<hex>" } | null,   // null when not provided
    "tools": [{ "name": "grype", "version": "0.0.0" }, ...], // qemu-img, libguestfs, syft, grype, action
    "operatingSystem": { "id": "ubuntu", "versionId": "24.04", "prettyName": "…", "arch": "x86_64" },
    "sbom": { "format": "spdx-json", "sha256": "<hex>" },
    "vulnerabilities": { "scanner": "grype", "dbVersion": "…", "sha256": "<hex>",
      "summary": { "critical": 0, "high": 0, "medium": 0, "low": 0, "negligible": 0, "unknown": 0 },
      "threshold": "high", "thresholdExceeded": false },
    "checks": [{ "id": "no-runner-credentials", "title": "…", "status": "pass", "detail": "…" }, ...],
    "policy": { "id": "builtin/v1", "sha256": "<hex> — present only when policy-path is used" },
    "result": "pass" | "fail",
    "workflow": { "repository": "…", "ref": "…", "sha": "…", "runId": "…", "runAttempt": "…", "eventName": "…", "actor": "…" }
  }
}
```

Every report — SBOM, vulnerability report, predicate — carries the same disk
SHA-256, so a reviewer can confirm they all describe one artifact.

### Where each field comes from

Each digest and property in the predicate has exactly one producing stage; the
predicate assembler (stage 8) only reads them off `state`:

- `artifact.sha256` / subject digest — `state.disk.sha256` (stage 2).
- `incusMetadata.sha256` — `state.metadata.sha256` (stage 4); `null` when unset.
- `buildManifest.sha256` — `state.buildManifest.sha256`, computed in `main.ts`
  via `hash.sha256File(build-manifest-path)` right after stage 1; `null` when
  unset.
- `tools` — `tools.toolVersions()` (Phase 1), including the resolved apt-package
  versions and this action's own version.
- `operatingSystem` — `state.fsView.operatingSystem` (stage 3).
- `sbom.sha256` — `state.sbom.sha256` (stage 5).
- `vulnerabilities.sha256` — `state.vuln.sha256`, the digest of the written
  `vulnerability-report.json` (stage 6).
- `checks` / `policy` — `state.contamination` (stage 7).
- `workflow` — `context.workflowContext()`.

The predicate's `incusMetadata` carries `{ sha256 }` only. The human-readable
`validation-report.json` additionally carries `incusMetadata.properties` — the
raw Incus properties object returned by stage 4 — kept separate from the
digest-only predicate field, satisfying the spec's "record metadata properties
in the validation report" requirement.

## Contamination policy

The built-in policy (`id: "builtin/v1"`) is a fixed rule array in
`src/contamination.ts`. `policy-path`, when set, supplies a replacement policy
file loaded by `contamination.loadPolicy(path)`; it **fully replaces** the
built-in set (no merge), and its `id` and SHA-256 (from `hash.sha256File`) are
recorded in the predicate's `policy` field. `loadPolicy` runs during input
resolution (stage 1), so a missing, unreadable, or malformed policy file —
including an unknown `matcher.type` — fails closed before any tool runs.

### Custom policy format

A policy file is JSON (shown compact):

```text
{
  "id": "org/example-v1",
  "rules": [
    { "id": "no-runner-credentials", "title": "…",
      "matcher": { "type": "path-glob", "glob": "**/actions-runner/.credentials*" } }
  ]
}
```

Each rule's `matcher.type` is one of four shapes, all evaluated read-only
against `fsView.mountPath`; a rule **fails** (contamination present) when its
matcher hits, **passes** when it does not, and is **skipped** when it cannot be
evaluated:

- `path-exists` — `{ type, path }`: fail if `path` exists.
- `path-glob` — `{ type, glob }`: fail if any path matches `glob`.
- `content-regex` — `{ type, path, pattern }`: fail if `path` exists and its
  contents match `pattern`.
- `non-empty-file` — `{ type, path }`: fail if `path` exists and is non-empty
  (used for machine-identity regeneration checks).

These four shapes cover every built-in check, so a custom policy is authored in
the same vocabulary the built-in rules use.

## Signing backends

The action produces useful, unsigned evidence in every mode; signing is layered
on top through a common `Signer` interface (`src/sign/index.ts`), selected only
by the explicit `signer` input.

### `none` (default, always supported)

Writes checksums, SBOM, reports, and the predicate without signing. This mode
requires only `contents: read` and works in **private repositories on any GitHub
plan, including Enterprise**.

### `github`

Delegates to the `@actions/attest` toolkit library (the library behind the
`actions/attest` action), using GitHub Actions OIDC. It generates three
attestations:

- **Build provenance** for the QCOW2 image and, when supplied, the metadata
  artifact (`attestProvenance`).
- An **SBOM attestation** for the QCOW2 image (`attest` with the SBOM
  predicate).
- A **custom validation attestation** using the generated validation predicate
  (`attest` with our predicate type).

The `github` signer **always** pushes the attestations to GitHub's attestation
API, so `attestation-url` is always set when it succeeds; the same bundles are
also written to `attestations/`. Because one output cannot carry three URLs,
`attestation-url` carries the **validation** attestation's URL — the run's
primary claim; the provenance and SBOM attestation URLs are printed in the
workflow log and all three bundles sit in `attestation-bundle-path`. The caller
must grant `id-token: write`, `attestations: write`, and `contents: read` — the
action cannot grant these itself. The attestation-API push authenticates with
the `github-token` input, which defaults to the workflow's `github.token`
(`GITHUB_TOKEN` is not ambient in a `uses:` step's environment, so it is an
explicit input, the same pattern `actions/attest` uses). Private and internal
repositories require GitHub Enterprise Cloud; **GitHub Enterprise Server is
unsupported**. Plan support is detected **reactively**: the action calls
`@actions/attest` and, if the API rejects the call because the repository plan
cannot issue attestations, catches that specific error and re-throws a
diagnostic naming the missing capability. It does not pre-probe the plan and it
never silently downgrades.

### `sigstore-keyless`, `cosign-key`, `kms` (post-v1 extension points)

These are post-v1. Only **one** external backend is planned, chosen by actual
consumer demand, and it will be added as a single new module behind the existing
`Signer` interface — no stub files are pre-created for the others. Until then,
`selectSigner` throws a diagnostic naming the requested backend rather than
falling back. `sigstore-keyless` will require explicit selection because
certificate and transparency-log records can expose repository and workflow
identity, and it will never be used automatically for private repositories.
`cosign-key` and `kms` support organization-controlled keys. Across all
backends, private key material is supplied only as a file, secret, agent, or KMS
**reference** through `signing-key` — never as raw plaintext.

## Error handling

**Fail-closed aborts.** The action calls `core.setFailed` and stops before any
evidence is emitted on these conditions:

| Condition                                         | Checked in |
| ------------------------------------------------- | ---------- |
| Missing or non-regular `disk-path`                | stage 2    |
| Non-QCOW2 format                                  | stage 2    |
| `qemu-img check` reports corruption               | stage 2    |
| Unexpected backing file                           | stage 2    |
| Filesystem cannot be fully inspected              | stage 3    |
| Unsafe or incomplete metadata archive             | stage 4    |
| SBOM generation error / zero components           | stage 5    |
| Vulnerability **scan** failure (crash/unparsable) | stage 6    |
| Selected signer's prerequisites unmet             | stage 10   |
| Input digest changed during the run               | stage 9    |
| Missing/unreadable/malformed `policy-path`        | stage 1    |

**Scan failure vs. findings over threshold.** These take separate code paths
with distinct messages. If Grype crashes, exits abnormally, or returns
unparseable output, that is a _scan error_: the action fails and records no
vulnerability verdict. If Grype completes successfully, the report is valid; if
its highest severity meets or exceeds `fail-on-severity`, the predicate records
`vulnerabilities.thresholdExceeded: true` and `result: "fail"`, and the action
fails as a _threshold failure_ — the scan itself succeeded and complete evidence
is written first.

**Cleanup guarantees.** `src/cleanup.ts` maintains a registry of every temporary
directory, libguestfs handle, and FUSE mount created during the run. The
orchestrator drains it in a `finally` block, so all mounts, handles, and temp
files are removed after both success and failure. The input disk is opened
read-only and never written; the pre/post digest comparison in stage 9 turns any
accidental modification into a hard failure.

## Security considerations

- **Untrusted image handling.** The disk filesystem is parsed read-only inside
  the isolated libguestfs appliance (direct backend) and served over FUSE, never
  mounted into the runner's host kernel, and no code from the image is ever
  executed.
- **Archive safety.** Incus tarballs are examined entry-by-entry before
  extraction; absolute paths, `..` traversal, symlink/hardlink escapes, and
  device nodes are rejected, and extraction targets a fresh temp directory.
- **No plaintext key inputs.** `signing-key` is always a reference (file path,
  secret name, agent, or KMS URI); raw key bytes are never accepted as an input
  value.
- **Tool and dependency pinning.** Standalone binaries are pinned by version and
  SHA-256 (with optional cosign verification) and fail closed on mismatch; apt
  packages are verified by apt's signed keyring; the `github` signer uses a
  library instead of a nested action, and any workflow this repo ships pins
  third-party actions by full commit SHA. Dependabot covers the npm and
  github-actions ecosystems.
- **Least privilege.** `signer: none` needs only `contents: read`; write scopes
  for the `github` backend must be granted by the caller.

Independent verification, documented in the README:

```sh
sha256sum -c checksums.txt                                      # any run
gh attestation verify disk.qcow2 --repo meigma/attest-vm-image  # signer: github
```

## Testing strategy

**Unit tests** (`__tests__/*.test.ts`, Jest ESM) follow the template's
`jest.unstable_mockModule` idiom. `@actions/core` is already mocked in
`__fixtures__/core.ts`; new fixtures mock `@actions/exec` and each tool wrapper
so tests never invoke real binaries. Covered as pure logic against captured
fixture output: input parsing, defaults, and validation; the QCOW2
format/integrity decision from sample `qemu-img` JSON; the tar-entry safety
checker (a path-traversal table); the custom-policy parser and
contamination-rule matching against sample file listings; the severity-threshold
comparator and the scan-error vs. findings-over-threshold classifier; predicate
assembly from fixture data (snapshot); checksum generation; and signer dispatch,
asserting the selected backend is used and that no backend ever falls back to
another.

**Integration tests** exercise the pieces that need real tools, real KVM, and a
real disk, which cannot run under Jest. A workflow at
`.github/workflows/integration.yml` on `ubuntu-24.04` generates a tiny QCOW2 at
test time and runs the built action with `signer: none`. Because the pipeline
fails closed on an image it cannot inspect, the test image cannot be a bare mkfs
filesystem: `qemu-img create` plus guestfish must populate an ext4 root that
libguestfs OS inspection recognizes — a minimal Debian-style layout with
`/etc/os-release`, the usual top-level directories, and a small dpkg database
(`/var/lib/dpkg/status`) listing a handful of packages. Otherwise stage 3
(package inventory) and stage 5 (zero-component SBOM) would abort by design. The
seeded package list includes at least one old package version with known
high/critical CVEs so the threshold-breach job scans real findings. The positive
job runs report-only (`fail-on-severity: none`) so those seeded findings do not
fail it, and asserts that the SBOM, vulnerability report, checksums, and
predicate exist, that every report carries the input digest, and that the input
disk is byte-identical afterward. Negative jobs confirm a corrupt or non-QCOW2
input fails clearly and that the seeded high-severity finding under
`fail-on-severity: high` fails the run. A separate opt-in job covers
`signer: github` where the repo plan allows it.

**CI gate.** Whenever `src/` changes, run `moon run root:package` and commit the
refreshed `dist/` in the same change. `moon run root:check` (format-check, lint,
Jest, `check-dist`, audit) remains the authoritative gate; prettier
`proseWrap: always` at 80 columns applies to this document.
