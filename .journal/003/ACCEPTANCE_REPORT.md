# Manual Acceptance Test Report

Date: 2026-07-21

## Executive verdict

`attest-vm-image` is **not ready for external release at the tested commit**.
The action's runtime behavior is strong, but a release-blocking packaging defect
prevents an ordinary consumer workflow from loading it:

- `meigma/attest-vm-image@e49388b52d8912801515bcc86c862901b4037087`
  failed during GitHub's action-staging phase because the committed `.claude`
  symlink points to an untracked `.agents` directory.
- No workflow step ran in that consumer test. A normal external `uses:` reference
  is therefore unusable at this commit.
- Checking out that exact commit and invoking it as a local action bypassed only
  GitHub's staging defect. With that workaround, the runtime acceptance matrix
  passed across real-image inspection, evidence production, signing,
  verification, and expected failure paths.

`setup-distrobuilder@796360886df2d75b60aec6ce344d747fbaee0e00`
(`v1.0.0`) **passed**. It installed Distrobuilder 3.3.1 from source on a genuine
cold cache miss, restored the same binary from cache, and built a real split
Incus VM image that `attest-vm-image` successfully inspected.

A second, non-blocking defect was found in `attest-vm-image`: on a private
repository under the Meigma GitHub Free plan, GitHub signing failed safely, but
the action did not translate GitHub's current plan-rejection message into its
promised named diagnostic.

## Scope and method

This was a manual hosted acceptance exercise, not a unit-test review or a new
durable test harness. I created a disposable repository under the Meigma
organization, wrote temporary workflow/configuration files there, dispatched
real GitHub-hosted runs, inspected the live logs, downloaded the generated
artifacts, independently parsed and hashed them, queried GitHub's attestation
API, and then prepared the disposable repository for deletion.

No source, workflow, test, or bundled `dist/` file in either product repository
was changed.

The tested environment was:

| Item | Exact value |
| --- | --- |
| Disposable caller | `meigma/attest-vm-image-acceptance-20260721-s003` |
| `attest-vm-image` | `e49388b52d8912801515bcc86c862901b4037087` |
| `setup-distrobuilder` | `796360886df2d75b60aec6ce344d747fbaee0e00` (`v1.0.0`) |
| Distrobuilder | `3.3.1` |
| Hosted runner label | `ubuntu-24.04` |
| Runner OS | Ubuntu 24.04.4 LTS |
| Runner image | `20260714.240.1` |
| Runner version | `2.335.1` |
| Runner architecture | x64 |
| Public-test head | `e23a1bcbeb247ab9602a779ad3a8ea150f3316d3` |
| Private-test head | `9a753e5ce0ee5b348fb3de9145ac3147784c0eab` |

GitHub's documented product boundary is relevant to the private test: public
repositories can use artifact attestations on current plans, while private and
internal repositories require GitHub Enterprise Cloud. The private test was
therefore an acceptance test of the action's failure handling, not an
expectation that GitHub would issue a private attestation.

References:

- [setup-distrobuilder](https://github.com/meigma/setup-distrobuilder)
- [Distrobuilder VM build documentation](https://linuxcontainers.org/distrobuilder/docs/latest/howto/build/)
- [GitHub artifact-attestation requirements](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

## Hosted runs

| Run | Caller SHA | Duration | Result | Purpose |
| --- | --- | ---: | --- | --- |
| `29850224558` | `d1333fe5494aaa4e0aee1f0bcc27d514e7dd7bec` | 5s job | **FAIL** | Normal external action consumption |
| `29850324719` | `760b7ebdeb8a283e370a43bd76b8df7277376766` | 7m16s | PASS | Exact-checkout workaround, cold setup, real build, unsigned baseline |
| `29851367636` | `e23a1bcbeb247ab9602a779ad3a8ea150f3316d3` | 15m09s | PASS | Full public runtime/signing/failure matrix |
| `29852801882` | `9a753e5ce0ee5b348fb3de9145ac3147784c0eab` | 4m42s | PASS with expected inner failure | Private-plan behavior |

The outer matrix workflows intentionally used `continue-on-error` around cases
that were expected to fail. Every following assertion checked the inner step's
actual outcome and the resulting filesystem/evidence state. An outer green run
therefore does not mean failure cases were silently ignored.

## Result matrix

| # | Test | Expected | Actual | Result |
| ---: | --- | --- | --- | --- |
| 1 | Normal external `uses: meigma/attest-vm-image@<SHA>` | GitHub stages and starts the action | Job failed in setup on missing `.claude`; no step ran | **FAIL — release blocker** |
| 2 | External `setup-distrobuilder@<SHA>` resolution | Released action stages normally | Action downloaded and executed normally | PASS |
| 3 | Cold Distrobuilder install | Build 3.3.1, `cache-hit=false` | Source build succeeded; correct outputs and cache miss | PASS |
| 4 | Same-key cache restore | Restore 3.3.1, `cache-hit=true` | 20,856,977-byte cache restored; correct outputs | PASS |
| 5 | Default `version: latest` resolution | Resolve current release and hit cache | Resolved 3.3.1 and restored exact key | PASS |
| 6 | Real Distrobuilder VM build | Produce split metadata plus clean QCOW2 | `incus.tar.xz` and 2 GiB virtual QCOW2 produced | PASS |
| 7 | Unsigned action defaults on the real image | Complete SPDX evidence, built-in policy pass, no signing | Five evidence files, seven checksum records, 15/15 policy checks pass | PASS |
| 8 | Read-only disk behavior | Disk digest unchanged | Pre/post digest identical in every checked path | PASS |
| 9 | Invalid `sbom-format` | Reject before evidence | Exact enum diagnostic; no evidence | PASS |
| 10 | QCOW2 with backing file | Reject before inspection/evidence | Named backing-file diagnostic; base and overlay unchanged; no evidence | PASS |
| 11 | Valid empty QCOW2 | Fail closed when no OS is found | Named no-root-filesystem diagnostic; no evidence; cleanup clean | PASS |
| 12 | Metadata tar containing `../escape` | Reject before extraction | Named traversal diagnostic; no escape file/evidence/temp residue | PASS |
| 13 | Default `high` vulnerability threshold | Evidence-complete failure when High findings exist | Six High matches; `thresholdExceeded=true`; complete unsigned evidence | PASS |
| 14 | CycloneDX plus custom policy | CycloneDX output and all four matcher types pass | CycloneDX 1.7, 4,307 components, policy hash correct, 4/4 checks pass | PASS |
| 15 | GitHub signer in public repository | Three persisted claims and three local bundles | Provenance, CycloneDX, and validation attestations issued | PASS |
| 16 | Online attestation verification | Verify disk/metadata provenance, disk SBOM, disk validation | Four `gh attestation verify` commands succeeded | PASS |
| 17 | Offline bundle verification | Verify the same four subject/claim combinations from bundles | Four bundle-backed verification commands succeeded | PASS |
| 18 | Deliberately contaminated real image | Policy fails on shell history; complete evidence; never sign | Sole failure `no-root-shell-history`; no bundles or online attestation | PASS |
| 19 | Unsigned action in private repository | Core evidence generation remains usable | Full evidence, 15/15 checks, unchanged disk, no signing output | PASS |
| 20 | GitHub signer on unsupported private plan | Fail safely with named plan diagnostic | Failed safely with complete evidence/no bundle, but generic message leaked | **PARTIAL / diagnostic FAIL** |
| 21 | Downloaded-artifact integrity | All retained evidence parses and hashes correctly | Public: 22/22 JSON and 24/24 retained checksum targets; private: all retained targets passed | PASS |
| 22 | Cleanup | No action mount/metadata residue after tested failures | Assertions found no `attest-mount-*`/`attest-metadata-*` residue | PASS |

## Finding 1: external action packaging is broken

Severity: **High / release blocker**

The first consumer workflow used the ordinary immutable reference:

```yaml
uses: meigma/attest-vm-image@e49388b52d8912801515bcc86c862901b4037087
```

GitHub downloaded both actions, then failed while staging `attest-vm-image`:

```text
Could not find file '.../attest-vm-image-e49388b52d8912801515bcc86c862901b4037087/.claude'.
```

Repository-tree inspection explains the failure:

- `.claude` is committed as a mode `120000` symlink.
- Its target is `.agents`.
- No `.agents` entry is committed; `.agents/` is ignored.
- The symlink is therefore dangling in the exact tree GitHub downloads.
- `CLAUDE.md -> AGENTS.md` is also committed, but that target exists and is
  valid.
- `setup-distrobuilder` has no committed `.claude` entry and staged normally.

The later workflows checked out the exact same action commit beneath
`.acceptance/attest-vm-image` and invoked it with a local `uses:` path. Checkout
can preserve a dangling symlink without GitHub's action-staging dereference, so
this was a narrow way to continue evaluating the runtime. It is not evidence
that normal external consumption works.

Recommended release gate: remove the dangling tracked symlink or commit a valid
target, then rerun a fresh repository using the ordinary external `uses:` form.
The repository's self-referential `uses: ./` integration cannot detect this
class of packaging failure by itself.

## setup-distrobuilder results

The cold baseline run exercised the released setup action from another
repository, not from its own checkout.

### Installation and outputs

- Requested/resolved version: `3.3.1` / upstream tag `v3.3.1`.
- First call: `cache-hit=false`; source build completed successfully.
- Output path: `/usr/local/bin/distrobuilder`.
- Installed file owner/mode: `root:root`, `0755`.
- Both runner-user and `sudo` PATH resolved the same binary.
- Both `distrobuilder --version` and `sudo distrobuilder --version` returned
  `3.3.1`.
- Required packages were present: `debootstrap`, `squashfs-tools`,
  `qemu-utils`, `btrfs-progs`, and `dosfstools`.
- Required VM helpers resolved: `btrfs`, `mkfs.ext4`, `mkfs.vfat`, `qemu-img`,
  `rsync`, and `sgdisk`.
- A second invocation restored key
  `distrobuilder-ubuntu24-X64-3.3.1`, reported `cache-hit=true`, and installed
  the same binary.
- The full run's calls were both cache hits, independently confirming public
  cache restore and default `latest` resolution after the cold-run proof.

### Real build

The temporary Distrobuilder definition used Ubuntu Noble x86_64, the
`debootstrap` `minbase` variant, a 2 GiB ext4 VM target, and removed both machine
ID paths. It was validated and built with:

```text
distrobuilder build-incus image.yaml build --vm --type=split
```

The full-matrix build produced:

- `build/disk.qcow2`: QCOW2 compatibility 1.1, zlib compression.
- Virtual size: 2,147,483,648 bytes.
- Allocated file size: 72,876,032 bytes.
- Backing file: none.
- `qemu-img check`: no errors.
- Disk SHA-256:
  `b5a5d1716cab79a5a0272f7b7bbf2ae6bc217c2496407b7ae469ba0bb6a17980`.
- `build/incus.tar.xz` containing root `metadata.yaml`.
- Metadata SHA-256:
  `fbcca6be4ffc0abdf873091aadab6744aff64c13d43937027075118ac07f1b1d`.
- Metadata identity: Ubuntu Noble, x86_64/amd64, serial
  `20260721_1704`.

The earlier cold run built a distinct real image, as expected for a timestamped
build: 72,810,496 allocated bytes and disk digest
`e39ed3e3147759bb8a3ee7e526248f59fa48b399254bf1858e2fb40df3fc04bd`.

## Unsigned real-image evidence

The action used its default output directory, default SPDX format, default
`signer: none`, and explicit `fail-on-severity: none` so mutable vulnerability
data could not turn the baseline into a false failure.

Observed evidence:

- `evidence/checksums.txt`
- `evidence/sbom.spdx.json`
- `evidence/vulnerability-report.json`
- `evidence/validation-report.json`
- `evidence/validation-predicate.json`

All action outputs named the correct paths. Signing outputs were empty and no
`attestations/` directory existed. The disk digest output matched an independent
pre-action hash, and the disk remained unchanged.

The seven checksum records covered the disk, Incus metadata, supplied build
manifest, and four evidence documents. They all verified on the runner. The
downloaded artifact deliberately omitted the 72 MB disk, but every retained
target independently matched its recorded hash.

Predicate/evidence facts:

- In-toto statement v1 and the action's VM-image validation predicate type.
- Result `pass` under policy `builtin/v1`.
- Ubuntu 24.04 LTS, x86_64.
- 15 built-in checks, all passing.
- Correct disk, metadata, build-manifest, repository, workflow SHA, run ID, and
  run-attempt linkage.
- SPDX 2.3 with 185 packages and 4,721 relationships.
- The SPDX document carried the disk SHA-256.
- Syft 1.48.0 and Grype 0.116.0.
- Grype database schema v6.1.9, built `2026-07-21T07:05:18Z`.
- 496 matches: Critical 0, High 6, Medium 334, Low 152, Negligible 4,
  Unknown 0.
- `threshold=none`, `thresholdExceeded=false`.

## Fail-closed and evidence-complete cases

### Invalid input

`sbom-format: invalid` failed before evidence creation with:

```text
sbom-format must be one of spdx-json, cyclonedx-json; got "invalid".
```

### Backing-file overlay

A real overlay referencing the genuine Distrobuilder disk failed before
inspection/evidence with a diagnostic naming the unexpected backing path. Both
the base and overlay hashes remained unchanged.

### No operating system

A valid 64 MiB empty QCOW2 passed format/integrity validation, then failed with:

```text
No operating system detected in "empty.qcow2"; libguestfs found no root filesystem.
```

No evidence or mount residue remained.

### Unsafe metadata archive

A real tar archive containing valid `metadata.yaml` plus `../escape` failed
before extraction with:

```text
Unsafe archive entry "../escape": parent-directory ("..") traversal is not allowed.
```

The sentinel was not written outside the extraction root. No evidence,
metadata temp directory, or mount residue remained.

### Vulnerability threshold

The same real image was run with the action's default `high` threshold. Six High
findings caused the expected evidence-complete failure. The predicate recorded
`result=fail` and `thresholdExceeded=true`; all 15 contamination checks still
passed. Signing was disabled, and all evidence/checksums were retained.

### Deliberate contamination and never-sign rule

A copy of the real QCOW2 was modified through guestfish to add
`/root/.bash_history`. With `signer: github` selected:

- The action generated complete evidence.
- Exactly one built-in check failed: `no-root-shell-history`.
- The validation predicate recorded `result=fail`.
- The action explicitly logged that a failing result is never signed.
- No bundle files or signing outputs appeared.
- An authenticated lookup for that unique contaminated disk digest returned no
  validation attestation.
- The action did not mutate the contaminated disk further.

## Custom policy, CycloneDX, and public GitHub signing

The custom policy exercised every supported matcher form: path existence,
path glob, content regex, and non-empty file. All four expected-absence rules
passed. Its recorded SHA-256 matched the independently computed policy hash:

```text
71541900f97ee45ab9f50e93dae669a81458f552712b5c48a438ff92f8e58367
```

The CycloneDX 1.7 SBOM contained 4,307 components and carried the disk SHA-256
on its metadata root component.

The public job granted exactly the required job permissions:

- `contents: read`
- `id-token: write`
- `attestations: write`

The action issued and retained:

| Claim | Predicate type | Attestation ID |
| --- | --- | ---: |
| Disk plus metadata provenance | `https://slsa.dev/provenance/v1` | `36403534` |
| Disk CycloneDX SBOM | `https://cyclonedx.org/bom` | `36403550` |
| Disk VM-image validation | `https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1` | `36403554` |

Exactly three Sigstore v0.3 DSSE bundles were written. An authenticated REST
lookup by disk digest returned exactly the same three claims. Independent
comparison found each API bundle JSON-equivalent to its downloaded local copy;
the validation statement matched `validation-predicate.json`, and the SBOM
predicate matched `sbom.cyclonedx.json`.

The Fulcio certificate identity recorded the expected repository, main-branch
workflow, exact source SHA, workflow-dispatch event, run URL, and GitHub-hosted
runner. Four online and four offline `gh attestation verify` commands all
succeeded:

- Disk SLSA provenance.
- Incus metadata SLSA provenance.
- Disk CycloneDX SBOM.
- Disk custom validation predicate.

Bundle paths were intentionally excluded from `checksums.txt`; the evidence
hashes describe pre-signing material rather than self-referential bundles.

## Private-plan behavior

The disposable repository was changed to private only after the public logs,
artifact, and attestation bundles were captured. The private job first asserted
that repository visibility was private and granted both OIDC and attestation
write permissions, eliminating missing permissions as an alternate explanation.

### Unsigned operation

`signer: none` passed normally in the private repository. It produced complete
evidence, passed all 15 built-in checks, retained an unchanged disk, and emitted
no signing output.

### Unsupported GitHub signing

The same passing image then used `signer: github`. The action completed all
inspection/evidence stages, created the empty bundle directory, and reached the
GitHub attestation API. GitHub rejected persistence because the Meigma plan does
not support private-repository attestations. The action failed closed; no bundle
file or signing output was created.

The expected named error was:

```text
this repository's plan cannot issue attestations; signer: github requires a public repository or GitHub Enterprise Cloud
```

It was not present. The actual error was:

```text
Failed to persist attestation: Feature not available for the meigma organization.
To enable this feature, please upgrade the billing plan, or make this repository
public.
```

The current classifier recognizes `Forbidden`, `Not Found`, `not accessible`,
and `Advanced Security`, but not GitHub's observed `Feature not available` /
`upgrade the billing plan` wording. This is a diagnosability defect, not a
fail-open defect: no attestation was issued and complete unsigned evidence was
preserved.

Recommended follow-up: extend the classifier and add the observed message as a
unit fixture, then repeat this private-plan case.

## Independent artifact inspection

Public artifact `8503896782` (`full-evidence`) was retained for one day and
reported:

- Compressed size: 2,734,264 bytes.
- Artifact digest:
  `sha256:b148fd86f5b089088d47729d64e74a2f1752b19a32327ef9f844009b3b197886`.
- 22/22 JSON documents parsed.
- 24/24 uploaded checksum targets matched, with no mismatch.
- Four omitted disk-image records matched the before-action digests recorded
  and verified on the runner.
- All four Grype reports independently contained the same 496-match severity
  totals.
- Exactly three signed bundles were present.

Private artifact `8504167397` (`private-plan-evidence`) was also retained for
one day:

- Compressed size: 111,282 bytes.
- Artifact digest:
  `sha256:d3bf19d9156072dce79712f4a6ccf2ee69e0509a1e97062aef2e7d28488b9101`.
- Both evidence sets parsed and every retained non-disk checksum target matched.
- The disk itself was intentionally omitted and had already passed full
  checksum verification on the runner.
- No signed bundle file was present.

## Timings

Cold baseline:

| Operation | Duration |
| --- | ---: |
| Cold setup-distrobuilder source build/install | 1m36s |
| Same-job cache restore | 2s |
| Real Distrobuilder split VM build | 1m45s |
| Unsigned real-image action | 3m43s |
| Whole job | 7m16s |

Full public matrix:

| Operation | Duration |
| --- | ---: |
| Cached setup-distrobuilder invocation | 15s |
| Second cache restore | 3s |
| Real Distrobuilder split VM build | 1m54s |
| Unsigned validation | 4m04s |
| Backing-file rejection | 2s |
| Empty-image rejection | 14s |
| Unsafe-metadata rejection | 1m22s |
| Threshold validation | 1m59s |
| Signed custom-policy validation | 2m09s |
| Online/offline verification | 29s |
| Contamination operation | 21s |
| Contaminated validation | 2m01s |
| Whole job | 15m09s |

Private-plan job:

| Operation | Duration |
| --- | ---: |
| Prerequisite installation | 1m36s |
| Calibrated image creation | 26s |
| Unsigned validation | 1m34s |
| GitHub-signing attempt through plan rejection | 55s |
| Whole job | 4m42s |

## Additional observations

- GitHub-hosted runners did not grant the runner user access to `/dev/kvm`.
  Libguestfs emitted repeated warnings and used a much slower software path.
  This affected duration, not correctness.
- Guestfish's application inventory plus Syft/Grype JSON stdout made individual
  action steps very noisy. Evidence files were complete and no log truncation
  was observed, but quieter tool invocation would make failures substantially
  easier to diagnose.
- The repository's small integration-image helper claims its seeded ELF makes
  libguestfs report `x86_64`; in the private run it reported `unknown`. The real
  Distrobuilder image correctly reported `x86_64`, so this did not weaken the
  main acceptance result, but the helper comment/fixture should be revisited.
- `attest-vm-image` has no release or major-version tag at the tested state.
  The immutable main SHA was intentional for pre-release acceptance, but the
  README's future release ref is not yet consumable.
- The real image was structurally built and deeply inspected, not booted as a
  guest. Boot behavior belongs to the image-builder/product acceptance layer;
  this action's contract is read-only post-build inspection and evidence.
- The mutable Ubuntu mirror and Grype database mean package/vulnerability
  counts are observations from this run, not stable golden values.

## Coverage not repeated

The exact action head already had a successful repository-local integration run
covering raw/non-QCOW2 rejection, structural QCOW2 corruption, a deterministic
seeded high-severity threshold case, and a basic public signing case. This
manual exercise concentrated hosted time on external consumption, a real
Distrobuilder-built image, real tar behavior, backing files, no-OS handling,
custom policy/CycloneDX, all online and offline claim types, never-sign-on-policy
failure, and the private-plan boundary.

Not exercised here:

- arm64 hosted execution.
- Ubuntu 22.04 as the action runner OS.
- `sigstore-keyless`, `cosign-key`, or `kms`, which the current action explicitly
  reports as external backends not yet implemented.
- Booting the produced VM.

## Recommended next acceptance slice

Keep the next iteration small:

1. Fix only the dangling `.claude` packaging defect and the observed private-plan
   message classifier.
2. Correct or tighten the seeded integration fixture's architecture assertion.
3. Repeat normal external consumption in a fresh disposable public repository.
4. Repeat the private-plan diagnostic case.
5. If both pass, cut the initial release and run one smoke using the released
   major-version tag rather than `main`.

## Cleanup

All raw logs and both evidence artifacts were downloaded before teardown. The
local temporary checkout and its workflow/configuration harness were moved to
Trash and are recoverable there until Trash is emptied. The downloaded raw
evidence remains under the system temporary directory for the immediate
follow-up; the durable deliverable is this report.

The remote repository is still present and private. Deletion was attempted by
CLI, but the authenticated token lacks `delete_repo`. Deletion through GitHub's
UI reached GitHub's sudo-mode security-key reauthentication screen, which
requires the account holder's physical confirmation. The in-app browser is left
at that handoff. After reauthentication, the already-entered delete flow can be
completed; until then the repository remains private and contains only the
temporary acceptance workflows and evidence-free Git history.
