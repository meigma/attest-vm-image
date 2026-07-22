# How to troubleshoot a failed run

Diagnose why an `attest-vm-image` step failed and get to the fix. Classify the
failure first, then jump to the matching symptom.

## Prerequisites

- The failed workflow run's logs. The action logs every command it runs.
- If your workflow uploads the evidence directory (default `./evidence`) as an
  artifact, download it. Whether it exists and how complete it is tells you
  which kind of failure occurred.

## Classify the failure first

A run fails in one of two ways. Determine which before doing anything else.

1. **Look at the evidence directory** (default `./evidence`, or your
   `output-directory`).

   - **Empty, absent, or partial** — missing `checksums.txt` or one of the
     report/predicate files. This is a **fail-closed abort**: a stage threw
     before the evidence was complete. Continue at
     [Fail-closed aborts](#fail-closed-aborts).
   - **Complete handoff** — `checksums.txt`, the SBOM,
     `vulnerability-report.json`, `validation-report.json`,
     `validation-predicate.json`, and `evidence-manifest.json` are all present.
     Usually this is an **evidence-complete failure**: the image was inspected
     and failed validation. Continue at
     [Evidence-complete failures](#evidence-complete-failures).
   - **Unsigned set without `evidence-manifest.json`** — this is a late
     **fail-closed abort**, not an evidence-complete failure. If `signer` is not
     `none` and the message names signing or attestations, the run passed
     validation and then aborted while signing; see
     [signing failed but the evidence looks complete](#problem-signing-failed-but-the-evidence-looks-complete).
     Otherwise the manifest itself could not be completed, for example because
     an evidence file disappeared before it could be hashed.

   The exact file list is in [Evidence files](reference.md#evidence-files).

2. **Confirm with the step outputs.** They are the reliable discriminator and
   settle the ambiguous case above. A thrown error sets no output at all: on any
   fail-closed abort — including a signing failure — `disk-digest`,
   `checksums-path`, and every other output are unset, even when evidence files
   already exist on disk. A pass and an evidence-complete failure both set the
   seven standard outputs, so their presence tells you the pipeline finished but
   not whether it passed. In short, the pre-manifest unsigned set with all
   outputs unset is a late fail-closed abort, not an evidence-complete failure.
   See [Outputs](reference.md#outputs).

## Evidence-complete failures

The pipeline finished, wrote every evidence file, and then failed. The image did
not pass validation.

Read the step's failure message. It names the reason(s): a vulnerability
threshold breach, one or more failed contamination checks, or both. Its exact
shape is the evidence-complete failure entry in
[Failure modes](reference.md#failure-modes).

- **Vulnerability threshold breach** — findings met or exceeded your
  `fail-on-severity`. Fix the image, or change what fails the run per
  [Control what fails validation](validation-policy.md).
- **Failed contamination check(s)** — the message lists the failing rule IDs.
  Remove the flagged artifact from the image, or adjust your policy per
  [Control what fails validation](validation-policy.md).

The evidence is complete; keep it for audit even though the run failed.

## Fail-closed aborts

A stage threw and the run stopped. Find your exact error string in
[Failure modes](reference.md#failure-modes) — it maps every message to a cause
and a remedy. The sections below cover the aborts that are about the runner or
its environment rather than the image itself.

Tool installation and the `syft`/`grype` downloads run before the disk is
validated, so `apt-get` and download log lines can appear even on a run that
ultimately aborts on a bad `disk-path` or a corrupt image. Read to the end of
the log for the thrown message.

### Problem: the runner cannot install packages or use sudo

The action self-installs `qemu-utils` and `libguestfs-tools` with `sudo apt-get`
on every run.

**Solution:** Use a Linux runner that permits `apt-get` and passwordless `sudo`.
GitHub-hosted `ubuntu-*` runners qualify by default; self-hosted runners must
grant both. See [Requirements](reference.md#requirements).

### Problem: no readable kernel image (`/boot/vmlinuz-*`)

The guest-inspection tooling needs a world-readable host kernel, and none
remained after the action's own `chmod`.

**Solution:** Use a runner whose `/boot/vmlinuz-*` can be made world-readable.
GitHub-hosted `ubuntu-*` runners work; some hardened self-hosted images strip or
lock down the kernel image. See [Requirements](reference.md#requirements).

### Problem: the run aborts naming the platform or architecture

The action runs only on Linux `x64` and `arm64`.

**Solution:** Move the job to an `ubuntu-*` runner (`runs-on: ubuntu-24.04`).
macOS, Windows, and other architectures fail closed; see the platform entries in
[Failure modes](reference.md#failure-modes).

### Problem: a step before the action cannot build or mount the QCOW2

A step earlier in the same job that builds or mounts the image with
`libguestfs`/`qemu` — for example a `guestfish` seeding step — runs before the
action installs anything, so `libguestfs-tools`/`qemu-utils` are missing and
`/boot/vmlinuz-*` is not yet readable.

**Solution:** Install the tools and fix kernel readability in that step
yourself, before the action runs:

```yaml
- run: |
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends qemu-utils libguestfs-tools
    sudo chmod +r /boot/vmlinuz-*
```

The action's own install still runs later and is harmless. See the same-job note
in [Requirements](reference.md#requirements).

### Problem: runs are correct but extremely slow

On GitHub-hosted `arm64` runners the guest-inspection tooling falls back to
software emulation.

**Solution:** Use an `x64` runner (`runs-on: ubuntu-24.04`) for supported, fast
runs. `arm64` is best-effort; see [how-it-works.md](how-it-works.md) for why it
is slow.

### Problem: tool or database downloads fail

The action needs outbound access to download the pinned `syft` and `grype`
binaries from `github.com` release assets and to fetch the Grype vulnerability
database at scan time. Symptoms are an integrity or download error while
fetching a binary, or a Grype scan error — see the vulnerability-scan and
tool-acquisition entries in [Failure modes](reference.md#failure-modes).

**Solution:** Allow egress to the endpoints listed under
[Requirements](reference.md#requirements). On locked-down or air-gapped runners,
pre-seed the Grype database and point Grype at it with the `GRYPE_DB_CACHE_DIR`
environment variable — set as a step- or job-level `env:` value, not an action
input — per [Requirements](reference.md#requirements).

### Problem: `signer: github` fails on plan or visibility

The GitHub attestation API rejected the push. Two different messages indicate
the **same** restriction:

- The translated plan/visibility diagnostic, which names the required repository
  type and permissions.
- The **raw, untranslated** API message
  `Failed to persist attestation: ... Feature not available ... upgrade the billing plan ...`.
  This billing-plan wording is not rewritten, but it means the same thing.

Both are cataloged in [Failure modes](reference.md#failure-modes).

**Solution:** Use a public repository, or a private/internal repository on
GitHub Enterprise Cloud (GitHub Enterprise Server is unsupported), and grant the
signing permissions. Full setup is in [Publish signed attestations](signing.md).
The action never downgrades to unsigned output.

### Problem: `signer: github` fails on a fork pull request

A pull request from a fork gets a read-only token and no OIDC identity, so it
cannot sign.

**Solution:** Run signing on pushes or on same-repository pull requests only.
See [Publish signed attestations](signing.md).

### Problem: an unimplemented signer throws only on a passing image

`sigstore-keyless`, `cosign-key`, and `kms` pass input validation but throw when
the signing step is reached. Signing runs only on a passing result, so the same
workflow configuration fails differently depending on the image: on a failing
image it fails with the ordinary evidence-complete-failure message (signing is
skipped, so no signer-related error appears); on a passing image the signer is
actually reached and throws the "not yet implemented" diagnostic instead.

**Solution:** Use `signer: none` or `signer: github`. See the signer entry in
[Failure modes](reference.md#failure-modes).

### Problem: signing failed but the evidence looks complete

A signing failure aborts after the unsigned evidence is sealed but before the
handoff is written. The checksum manifest and unsigned evidence documents exist
on disk, but `evidence-manifest.json` does not and — as with every thrown error
— the run sets no outputs. `attestation-url`, `attestation-bundle-path`, and the
seven standard outputs are all empty.

**Solution:** Fix the signing failure using the relevant entry above, then
re-run. The unsigned evidence from the failed run is valid on its own; a later
step that reads outputs must tolerate them being unset.

## Related

- [Reference: Failure modes](reference.md#failure-modes) — every error message,
  its cause, and its remedy.
- [Reference: Requirements](reference.md#requirements) — runner, permission, and
  network prerequisites.
- [Control what fails validation](validation-policy.md) — threshold and policy
  tuning.
- [Publish signed attestations](signing.md) — signing permissions and setup.
- [How attest-vm-image works](how-it-works.md) — the failure model and why arm64
  is slow.
