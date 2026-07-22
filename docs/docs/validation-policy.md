# How to control what fails validation

The action marks a run's overall `result` as `fail` for exactly two reasons: a
vulnerability threshold breach or a failed contamination check. This guide shows
how to tune both levers — the `fail-on-severity` threshold and a custom
contamination policy.

When the result is `fail`, the run still produces complete evidence but is never
signed, so a failing image is never attested — see
[how-it-works.md](how-it-works.md) for why, and
[reference.md#outputs](reference.md#outputs) for exactly which outputs are set.

## Prerequisites

- A working unsigned run. If you do not have one yet, follow
  [getting-started.md](getting-started.md) first.
- The input and outcome details this guide links to live in
  [reference.md](reference.md).

## Choose a vulnerability threshold

`fail-on-severity` decides which Grype findings breach the threshold and fail
the run. It takes one of three values (default `high`):

| `fail-on-severity` | Breaches on                                             |
| ------------------ | ------------------------------------------------------- |
| `critical`         | Critical findings only.                                 |
| `high` (default)   | Critical or high findings.                              |
| `none`             | Nothing — the scan is recorded but never fails the run. |

Set it in the step:

```yaml
- uses: meigma/attest-vm-image@v1
  with:
    disk-path: image.qcow2
    fail-on-severity: critical
```

Grype findings are tallied into six severity buckets: `critical`, `high`,
`medium`, `low`, `negligible`, and `unknown` (any severity Grype reports outside
the five named levels, including a missing one). Only the `critical` and `high`
buckets can ever breach the threshold. There is no setting that fails the run on
`medium` and below. To gate on those, read the full per-finding detail directly
from `vulnerability-report.json` in the evidence directory (for example
`jq . evidence/vulnerability-report.json`) and run your own policy over it.

### Threshold breach versus scan error

A threshold breach is not the same as a scan error, and `fail-on-severity` only
governs the former. A clean scan whose findings meet the threshold writes the
full `vulnerability-report.json`, sets its seven standard outputs, and fails the
run afterward (an evidence-complete failure) — lowering the gate to
`fail-on-severity: none` keeps that run green while still recording the
findings. A Grype crash, non-zero exit, empty output, or unparseable JSON is a
scan error: it aborts before any report is written, sets no outputs, and
`fail-on-severity` has no effect on it. Both are cataloged in
[reference.md#failure-modes](reference.md#failure-modes).

## Customize the contamination policy

Supply `policy-path` when the
[built-in policy](reference.md#built-in-contamination-policy) does not match
your image. The file is parsed and structurally validated up front; a malformed
file or unknown matcher fails closed, naming the offending rule and field (see
[reference.md#failure-modes](reference.md#failure-modes)).

A custom policy **fully replaces** the built-in set — it is never merged. Start
from the built-in JSON in
[reference.md#built-in-contamination-policy](reference.md#built-in-contamination-policy)
and edit from there; any built-in rule you drop is no longer enforced.

### Policy file shape

```json
{
  "id": "myorg/v1",
  "rules": [
    {
      "id": "no-example",
      "title": "Human-readable statement of what must be true",
      "matcher": { "type": "path-exists", "path": "/some/path" }
    }
  ]
}
```

- `id` — a string identifying the policy; recorded in the predicate's
  `policy.id`.
- `rules` — an ordered array. Each rule needs a string `id`, a string `title`,
  and one `matcher` object.

### Matcher types

Every matcher is evaluated read-only against the mounted guest filesystem. All
`path` and `glob` values are absolute paths anchored at the image's root, so
`/etc/machine-id` means the guest's `/etc/machine-id`. There are four types:

| `type`           | Fields                       | Fails when                                                          |
| ---------------- | ---------------------------- | ------------------------------------------------------------------- |
| `path-exists`    | `path`                       | The path exists (file, directory, or symlink; not followed).        |
| `path-glob`      | `glob`, optional `exclude[]` | Some guest path matches `glob` and no `exclude` entry covers it.    |
| `content-regex`  | `path`, `pattern`            | The file at `path` exists and its contents match `pattern`.         |
| `non-empty-file` | `path`                       | The file at `path` exists and is non-empty (symlinks are followed). |

Notes on the shapes:

- `path-exists` checks existence without following symlinks: a symlink itself
  counts as present. `non-empty-file` follows symlinks and tests the resolved
  target's size (this is how the built-in D-Bus machine-id check works).
- `content-regex`'s `pattern` is a JavaScript regular expression compiled with
  no flags and tested against the file's full UTF-8 contents, so `^` and `$`
  anchor the whole file rather than each line. An absent file passes; a file
  that exists but cannot be read, or a pattern that is not a valid regex, makes
  the rule `skip` (see below).
- `path-glob`'s optional `exclude` is an array of globs using the same syntax;
  excluding a directory also excludes everything beneath it.

### Glob syntax

`path-glob` and its `exclude` entries use this syntax, matched against each
guest entry's full path from the root:

- `**/` matches zero or more directory levels.
- `**` matches any characters, including `/`.
- `*` matches any characters within a single path segment (never `/`).
- `?` matches exactly one non-`/` character.
- `{a,b,c}` matches any one of the comma-separated alternatives.

Every glob is anchored to the guest root whether or not it starts with `/` — a
leading `/` is optional and stripped before matching. To match at any depth,
prefix the pattern with `**/` (e.g. `**/id_rsa`), not by dropping the leading
slash. The filesystem walk never descends symlinked directories.

### Rule statuses

Each rule produces one status: `pass` (matcher did not hit), `fail` (matcher
hit), or `skip` (matcher could not be evaluated). Only a `fail` affects the
run's result — a `skip` never fails the run. A custom rule that silently skips
gives false assurance, so test that yours actually fires (see the worked example
below). The per-rule checks are recorded in the predicate.

### Point the action at your policy

```yaml
- uses: meigma/attest-vm-image@v1
  with:
    disk-path: image.qcow2
    policy-path: .github/contamination-policy.json
```

The policy file's SHA-256 is recorded in the predicate under `policy.sha256`
(the built-in policy carries no `sha256`), so a verifier can confirm which
policy gated the image.

## Worked example: add a rule to the built-in set

Goal: keep all the built-in checks and additionally fail if AWS credential files
shipped in the image.

1. Copy the built-in policy JSON from
   [reference.md#built-in-contamination-policy](reference.md#built-in-contamination-policy)
   into `.github/contamination-policy.json`.

2. Append one rule to the `rules` array:

   ```json
   {
     "id": "no-aws-credentials",
     "title": "AWS credential files are absent from home directories",
     "matcher": {
       "type": "path-glob",
       "glob": "/{root,home}/**/.aws/credentials"
     }
   }
   ```

3. Point the action at the file with `policy-path`, as shown above, and run.

Confirm it works: on a clean image the new check appears in
`validation-predicate.json` with status `pass`. Plant a test
`/root/.aws/credentials` file in a throwaway image and rerun — the check flips
to `fail`, and the run fails with the check id named in the message (see the
evidence-complete failure entry in
[reference.md#failure-modes](reference.md#failure-modes)).

## Related

- [reference.md#built-in-contamination-policy](reference.md#built-in-contamination-policy)
  — the 15 built-in rules and your starting point for a custom policy.
- [reference.md#failure-modes](reference.md#failure-modes) — every error
  message, including malformed-policy and evidence-complete failures.
- [verification.md](verification.md) — extracting the evidence and predicate for
  downstream policy engines.
