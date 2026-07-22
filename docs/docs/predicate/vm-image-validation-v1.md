# Validation predicate — `vm-image-validation` v1

This document describes version 1 of the `attest-vm-image` validation predicate:
the typed payload of the in-toto **statement** the action emits for every run.
The machine-readable JSON Schema lives beside this file at
[`vm-image-validation-v1.schema.json`](vm-image-validation-v1.schema.json),
whose `$id` equals the predicate type verbatim.

## Predicate type

```text
https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1
```

This URI is an **opaque, versioned identifier**. In-toto predicate types need
not resolve to a live endpoint, and this action stands up no site to serve it;
reviewers read the schema at its GitHub blob URL. A breaking change mints a `v2`
URI and a new schema pair, retaining `v1`.

## Statement envelope

The predicate is wrapped in a standard in-toto statement:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "disk.qcow2", "digest": { "sha256": "<hex>" } }],
  "predicateType": "https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1",
  "predicate": { "...": "described below" }
}
```

- **`_type`** — always the in-toto statement type above.
- **`subject`** — exactly one entry: the disk basename and its SHA-256 digest.
  The same digest appears again as `predicate.artifact.sha256`, in the SBOM
  subject, and in the vulnerability report, so a reviewer can confirm every
  document describes one artifact.
- **`predicateType`** — the predicate type URI above.
- **`predicate`** — the validation payload, specified below.

## Predicate fields

Every field below is always present unless explicitly noted. Each value is
produced by exactly one pipeline stage and copied into the predicate unchanged;
the assembler recomputes nothing.

### `schemaVersion`

The string `"1"`. Bumped only by a new predicate-type URI.

### `artifact`

The inspected QCOW2 disk image.

| Field       | Type    | Description                                    |
| ----------- | ------- | ---------------------------------------------- |
| `name`      | string  | Basename of the `disk-path` input.             |
| `sizeBytes` | integer | On-disk size of the QCOW2 file, in bytes.      |
| `sha256`    | string  | SHA-256 of the input disk file, lowercase hex. |

### `incusMetadata`

`{ "sha256": "<hex>" }` when a `metadata-path` was supplied, otherwise `null`.
The predicate carries the **digest only**. The raw Incus `properties` object is
recorded separately in `validation-report.json`, never here.

### `buildManifest`

`{ "sha256": "<hex>" }` when a `build-manifest-path` was supplied, otherwise
`null`. Digest only.

### `tools`

An array of `{ "name", "version" }` pairs for every tool that produced the
evidence — `syft` and `grype` (pinned versions), `qemu-utils` and
`libguestfs-tools` (the actually-installed apt versions from `dpkg-query`), and
this action itself. The list is informational and may grow across patch
releases; consumers should not assume a fixed length or order.

### `operatingSystem`

Guest OS identity read from `/etc/os-release`, plus the libguestfs-detected
architecture.

| Field        | Type   | Source                          |
| ------------ | ------ | ------------------------------- |
| `id`         | string | `ID`, e.g. `ubuntu`.            |
| `versionId`  | string | `VERSION_ID`, e.g. `24.04`.     |
| `prettyName` | string | `PRETTY_NAME`.                  |
| `arch`       | string | libguestfs arch, e.g. `x86_64`. |

### `sbom`

The generated SBOM.

| Field    | Type   | Description                                          |
| -------- | ------ | ---------------------------------------------------- |
| `format` | enum   | `spdx-json` or `cyclonedx-json`.                     |
| `sha256` | string | SHA-256 of the written SBOM file (subject embedded). |

### `vulnerabilities`

The vulnerability scan result.

| Field               | Type    | Description                                        |
| ------------------- | ------- | -------------------------------------------------- |
| `scanner`           | string  | Scanner name (e.g. `grype`).                       |
| `dbVersion`         | string  | Vulnerability-database schema/build rendering.     |
| `sha256`            | string  | SHA-256 of the written vulnerability report.       |
| `summary`           | object  | Per-severity counts (see below).                   |
| `threshold`         | enum    | `critical`, `high`, or `none` — the run's policy.  |
| `thresholdExceeded` | boolean | True when any finding met or exceeded `threshold`. |

`summary` carries a non-negative integer for each of `critical`, `high`,
`medium`, `low`, `negligible`, and `unknown`.

### `checks`

One entry per evaluated contamination rule.

| Field    | Type   | Description                                   |
| -------- | ------ | --------------------------------------------- |
| `id`     | string | Stable rule identifier, e.g. `no-machine-id`. |
| `title`  | string | Human-readable rule description.              |
| `status` | enum   | `pass`, `fail`, or `skip`.                    |
| `detail` | string | What was found or why the rule was skipped.   |

A rule **fails** when its matcher hits (contamination present), **passes** when
it does not, and is **skipped** when it could not be evaluated.

### `policy`

The contamination policy identity.

| Field    | Type   | Description                                               |
| -------- | ------ | --------------------------------------------------------- |
| `id`     | string | Policy id, e.g. `builtin/v1` or a custom policy's own id. |
| `sha256` | string | Present **only** when a custom `policy-path` was used.    |

The built-in policy carries no `sha256`; its rule set is fixed in the action's
source and versioned by its `id`.

### `result`

`"pass"` or `"fail"`. The result is `"fail"` when **any** contamination check
has `status: "fail"` **or** `vulnerabilities.thresholdExceeded` is `true`;
otherwise `"pass"`. An unsafe or invalid metadata archive is a fail-closed abort
in an earlier stage and never reaches the predicate.

### `workflow`

The GitHub Actions workflow context, captured from the standard `GITHUB_*`
environment variables: `repository`, `ref`, `sha`, `runId`, `runAttempt`,
`eventName`, and `actor`. A variable that is unset at runtime is recorded as an
empty string.

## Relationship to `validation-report.json`

`validation-report.json` is a human/machine-readable sibling that **flattens**
this predicate and adds the statement's `subject` and `predicateType` for
context. It differs from the predicate in exactly one way: its `incusMetadata`
also carries the raw Incus `properties` object
(`{ "sha256": "<hex>", "properties": { … } }`). Those properties are kept out of
the digest-only predicate field on purpose; consult the report when you need
them.
