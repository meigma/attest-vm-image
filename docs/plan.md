# attest-vm-image — Implementation Plan

Companion to [docs/design.md](design.md). Module names, tool choices, evidence
filenames, and the predicate URI here are the ones fixed in the design; this
document sequences the build.

## v1 boundary

**v1 is done when Phases 0–5 are complete.** That covers product Slice 1
(portable evidence: QCOW2 validation, read-only inspection, SBOM, vuln scan,
contamination checks, checksums, predicate, `signer: none`) and Slice 2
(`signer: github` via the `@actions/attest` library, with clear diagnostics for
unsupported repository plans).

**Post-v1 (not in scope here):** Slice 3, one external signing backend
(`sigstore-keyless`, `cosign-key`, or `kms`), added only on real consumer
demand. Phase 5 lands the `Signer` interface plus `selectSigner` dispatch in
`src/sign/index.ts`; a future session adds the single chosen backend as one new
`src/sign/<backend>.ts` file behind that dispatch, without reshaping anything.
No stub files are pre-created for backends that do not yet exist.

## Standing rules (apply to every phase)

- **dist/ is committed.** Any change under `src/` requires
  `moon run root:package` and committing the refreshed `dist/` in the same
  change, or CI's `check-dist` fails.
- **CI gate** is `moon run root:check` (format-check, lint, jest, check-dist,
  audit). Every phase ends green.
- **Prose wraps at 80 columns** (prettier `proseWrap: always`); tables and code
  fences may run wide.
- **Tests** use the template idiom: `jest.unstable_mockModule` with reusable
  mocks in `__fixtures__/`. No test invokes a real external binary. Run a single
  test file with `npm test -- <path>` so the ESM Jest flags the repo's `test`
  script sets (`NODE_OPTIONS=--experimental-vm-modules`) are applied.
- **Merges are squash-only; PR title is the main-branch commit subject** and
  must be a Conventional Commit (`feat:`, `fix:`, `docs:`, `chore:`). One PR per
  phase unless noted.

---

## Phase 0 — Template conversion and interface

**Scope.** Replace all `template-actions` / `wait` sample identity with the real
`attest-vm-image` interface and declare the full input/output surface, so later
phases fill in behavior against a stable contract. No pipeline logic yet.

**Tasks.**

- Rewrite `action.yml`: `name: attest-vm-image`, real `description`/`author`,
  and the exact inputs (`disk-path` required; `metadata-path`,
  `build-manifest-path`, `output-directory` default `./evidence`, `sbom-format`
  default `spdx-json`, `fail-on-severity` default `high`, `policy-path`,
  `signer` default `none`, `signing-key`) and outputs (`disk-digest`,
  `checksums-path`, `sbom-path`, `vulnerability-report-path`,
  `validation-report-path`, `validation-predicate-path`,
  `attestation-bundle-path`, `attestation-url`). Keep
  `runs: { using: node24, main: dist/index.js }`.
- `package.json`: set `name` `attest-vm-image`, `description`, `homepage`,
  `repository.url`, `bugs.url` to `meigma/attest-vm-image`; drop the sample
  `keywords`. Add runtime deps `@actions/exec`, `@actions/tool-cache`,
  `@actions/glob`, `@actions/attest` via `npm install` (updates
  `package-lock.json`).
- `moon.yml`: `project.title` / `project.description` → `attest-vm-image`.
- `SECURITY.md`: point the private-vulnerability-reporting link at
  `meigma/attest-vm-image`.
- `release-please-config.json`: `packages["."].package-name` →
  `attest-vm-image`. Leave `.release-please-manifest.json` at `0.1.0`.
- Delete `src/wait.ts`, `__tests__/wait.test.ts`, `__fixtures__/wait.ts`.
- Add `src/inputs.ts` exporting `parseInputs()` → typed `Inputs` object (reads
  `core.getInput`, applies the defaults above, validates enums for `signer` /
  `sbom-format` / `fail-on-severity`, rejects a missing `disk-path` or a backend
  that needs `signing-key` with none given, and — when `policy-path` is set —
  confirms the file exists and is readable). Add `__tests__/inputs.test.ts`
  covering defaults, each enum rejection, the `signing-key` requirement, and the
  unreadable-`policy-path` rejection.
- Rewrite `src/main.ts` `run()` to `parseInputs()` then `core.info` a
  not-yet-implemented notice inside a `try/catch` that calls `core.setFailed`;
  rewrite `__tests__/main.test.ts` accordingly (mock `../src/inputs.js`). Leave
  `src/index.ts` unchanged.
- Rewrite `README.md`: what the action does, the inputs/outputs tables, the
  Slice-1 usage example, and a placeholder "Verification" section filled in
  Phase 5. Remove the "sample action" section.

**Dependencies.** None.

**Success criteria.**

- `moon run root:package` then `moon run root:check` pass; `git status` shows
  `dist/` staged with the change.
- `grep -R "wait\|milliseconds\|template-actions" src action.yml package.json moon.yml SECURITY.md release-please-config.json`
  returns nothing.
- `npm test -- __tests__/inputs.test.ts` green; every enum-rejection case
  asserts a distinct `core.setFailed` message.
- `action.yml` is valid YAML (enforced by the prettier check
  `moon run root:check` runs over it) and declares all eight outputs
  (grep-verified).

---

## Phase 1 — Runtime foundation: exec, tools, hash, cleanup, context

**Scope.** Build the shared plumbing every stage needs: a captured-output exec
wrapper, pinned tool acquisition with integrity verification, a file/buffer hash
helper, the deferred cleanup registry, and GitHub context capture. All
independently unit-tested; not yet wired into a running pipeline.

**Tasks.**

- `src/exec.ts`: `exec(cmd, args, opts)` wrapping `@actions/exec` and returning
  `{ stdout, stderr, exitCode }`; groups output with `core.startGroup`. Add
  `__fixtures__/exec.ts` mocking it for downstream tests.
- `src/hash.ts`: `sha256File(path)` and `sha256Buffer(buf)` (node `crypto`),
  returning lowercase hex. Consumed by `disk.ts`, `contamination.ts`, `vuln.ts`,
  `checksums.ts`, and `main.ts` (build-manifest digest) so every digest has one
  implementation. `__tests__/hash.test.ts` checks a known-vector digest.
- `src/tools.ts`: **`PINNED_TOOLS`** — a `Record<string, ToolPin>` where each
  pin holds `version`, per-platform `sha256` (keys `linux-x64`, `linux-arm64`),
  and a release-URL template, for `syft` and `grype`. **`APT_PACKAGES`** — the
  list `['qemu-utils', 'libguestfs-tools']` (no version pin: Ubuntu's archive
  carries only the current build). `ensureBinary(name)` downloads via
  `@actions/tool-cache`, recomputes SHA-256 with `hash.sha256File`, compares to
  `PINNED_TOOLS[name].sha256[platform]`, **aborts on mismatch**, and caches;
  `ensureAptPackages()` runs `apt-get install`, fails if install fails, then
  runs `sudo chmod +r /boot/vmlinuz-*` and fails closed if no readable kernel
  remains — Ubuntu ships the kernel image root-readable only, and the libguestfs
  direct backend's supermin appliance must read it as the non-root runner user.
  `toolVersions()` returns resolved name/version pairs for the predicate —
  `syft`/`grype` from `PINNED_TOOLS`, `qemu-utils`/`libguestfs-tools` from
  `dpkg-query -W` **after** install (the actually-installed versions), and this
  action's own version from `package.json`. Placement of pins: literals in
  `src/tools.ts`, read only by `src/tools.ts`, bumped by a reviewed PR (labeled
  like a dependency change).
- `src/cleanup.ts`: `CleanupRegistry` with `add(fn)` and `drain()` (runs
  registered teardowns LIFO, catching and logging each so one failure cannot
  strand others). One instance is created in `main.ts` and drained in `finally`.
- `src/context.ts`: `workflowContext()` reading `GITHUB_REPOSITORY`,
  `GITHUB_REF`, `GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
  `GITHUB_EVENT_NAME`, `GITHUB_ACTOR` into a typed object consumed by
  `src/predicate.ts`.
- Tests: `__tests__/tools.test.ts` (sha256 match caches / mismatch throws, using
  a fixture buffer and mocked tool-cache; `ensureAptPackages()` issues the
  kernel-readability chmod after install and throws when it fails;
  `toolVersions()` reads dpkg-query output from `__fixtures__/exec.ts`),
  `__tests__/cleanup.test.ts` (drain order, isolation on throw),
  `__tests__/context.test.ts` (env → object, missing-var handling). Add
  `__fixtures__/samples/` for captured tool output used from Phase 2 on.

**Dependencies.** Phase 0.

**Success criteria.**

- `moon run root:package` + `moon run root:check` pass with `dist/` committed.
- `__tests__/tools.test.ts` proves a one-byte-altered download throws before any
  execution and never caches.
- `cleanup` test asserts teardown 2 still runs when teardown 1 throws.
- `toolVersions()` returns a non-empty array including the action's own version
  and the dpkg-resolved apt-package versions.

---

## Phase 2 — Disk validation, filesystem inspection, metadata

**Scope.** The read-only evidence-gathering front half: prove the input is a
sound QCOW2, mount and inventory its filesystem inside the isolated libguestfs
appliance, and validate an optional Incus tarball before extraction. Every path
fails closed and registers cleanup.

**Tasks.**

- `src/disk.ts`: `validateDisk(path)` — assert regular file; run
  `qemu-img info --output=json` and require `format === 'qcow2'`; reject a
  non-empty `backing-filename`; run `qemu-img check`; return
  `{ sha256, sizeBytes, virtualSize, actualSize, compat }` (`sha256` from
  `hash.sha256File`). `main.ts` stores this as `state.disk`; `state.disk.sha256`
  is re-verified in Phase 4's checksum stage.
- `src/inspect.ts`: `inspectFilesystem(path, registry)` — open the disk
  **read-only** with libguestfs and mount its root read-only into a fresh temp
  dir via the libguestfs FUSE mount (`guestmount`, `LIBGUESTFS_BACKEND=direct`),
  register handle + unmount on the `CleanupRegistry`, detect OS + root fs, read
  `/etc/os-release` into an `operatingSystem` object, and inventory OS packages.
  Returns a single `fsView` object `{ operatingSystem, packages, mountPath }`
  (one mount per run) that Phase 3's SBOM and contamination stages both read.
  Fails if the root fs or package DB cannot be fully enumerated.
- `src/metadata.ts`: `validateMetadata(path)` — list tar entries **before**
  extraction; reject absolute paths, `..` traversal, symlink/hardlink escapes,
  and device nodes; require `metadata.yaml`; validate required Incus fields;
  extract into a fresh temp dir registered for cleanup; return
  `{ sha256, properties }` (`sha256` from `hash.sha256File`; `properties` = the
  raw Incus properties object).
- Tests: `__tests__/disk.test.ts` (qcow2 accept, non-qcow2 reject, corrupt-check
  reject, backing-file reject — all from
  `__fixtures__/samples/qemu-img-*.json`), `__tests__/metadata.test.ts` (a
  path-traversal table of unsafe entries plus a valid archive, asserting
  `properties` is returned), `__tests__/inspect.test.ts` (os-release + package
  parsing from captured `guestfish`/`guestmount` output; incomplete-enumeration
  throws). All external calls go through the mocked `__fixtures__/exec.ts`.

**Dependencies.** Phase 1 (exec, hash, cleanup, tools).

**Success criteria.**

- `moon run root:check` green with `dist/` committed.
- Disk tests cover accept + three distinct failure reasons with distinct
  messages; metadata test table includes at least absolute path, `..`, and a
  symlink escape, each rejected.
- Inspect test asserts a fully-parsed run registers exactly one mount + handle
  on the cleanup registry and returns `mountPath`, and that an incomplete run
  throws before returning a package list.

---

## Phase 3 — SBOM, vulnerability scan, contamination

**Scope.** Turn the inspected filesystem view into an SBOM, scan that SBOM for
vulnerabilities with a clean scan-error vs. findings-over-threshold split, and
run the built-in (or custom) contamination policy. All produce structured
results the predicate consumes.

**Tasks.**

- `src/sbom.ts`: `generateSbom(fsView, format, diskSha256)` — run Syft against
  `fsView.mountPath` (a directory source, not the raw QCOW2), emit `spdx-json`
  (default) or `cyclonedx-json`, embed `diskSha256` as the SBOM subject, fail on
  Syft error or zero components, return `{ path, format, sha256 }` (`sha256`
  from `hash.sha256File`). Writes `sbom.spdx.json` or `sbom.cyclonedx.json`.
- `src/vuln.ts`: `scanVulnerabilities(sbomPath, threshold)` — run Grype on the
  SBOM, record scanner + DB schema version/timestamp, honor a cache dir,
  classify a crash/abnormal-exit/unparseable output as a **scan error** (throw →
  action fails, no verdict), and for a clean scan write
  `vulnerability-report.json` and return
  `{ path, sha256, scanner, dbVersion, summary, thresholdExceeded }` — `sha256`
  (of the written report, via `hash.sha256File`) feeds the predicate's
  `vulnerabilities.sha256`; `thresholdExceeded` is computed by a
  `severityAtOrAbove(threshold)` comparator. A threshold breach is a **threshold
  failure** recorded later in the predicate, not a throw here.
- `src/contamination.ts`: **`BUILTIN_POLICY`** — a rule array
  (`id`/`title`/`matcher`, `matcher.type` ∈
  `path-exists`/`path-glob`/`content-regex`/`non-empty-file`; policy
  `id: 'builtin/v1'`) covering runner registration credentials, private keys and
  obvious credential files, persisted SSH host keys, non-empty machine identity,
  cloud-init instance state, package-manager/provisioning credentials, and build
  temp files in sensitive locations. `loadPolicy(policyPath)` — parse the JSON
  policy file (the "Custom policy format" in design.md), **fully replace** the
  built-in set, validate every `matcher.type` (unknown type → throw, fail
  closed), and record the file's `sha256` (via `hash.sha256File`); returns the
  `BUILTIN_POLICY` when `policyPath` is unset.
  `runContamination(fsView, policy)` evaluates each matcher read-only against
  `fsView.mountPath` and returns per-check `pass`/`fail`/`skip` plus the
  `{ id, sha256? }` policy identity.
- Tests: `__tests__/sbom.test.ts` (format selection, zero-component failure,
  subject digest equals `diskSha256`), `__tests__/vuln.test.ts` (comparator
  table across critical/high/none; scan-error classifier vs.
  clean-with-findings, from `__fixtures__/samples/grype-*.json`; asserts the
  returned `sha256` matches the written report),
  `__tests__/contamination.test.ts` (each `matcher.type` matched against a
  sample file listing; `loadPolicy` replace-semantics + digest; malformed /
  unknown-matcher policy throws).

**Dependencies.** Phase 2 (`fsView` feeds SBOM + contamination); Phase 1 tools +
hash.

**Success criteria.**

- `moon run root:check` green with `dist/` committed.
- `__tests__/vuln.test.ts` proves the two failure modes take different paths:
  scan error throws; findings-over-threshold returns `thresholdExceeded: true`
  without throwing.
- Contamination test exercises every `BUILTIN_POLICY` rule id at least once and
  proves a custom policy replaces the built-in set and is rejected when
  malformed.
- SBOM test confirms the emitted file's subject digest equals the input disk
  digest.

---

## Phase 4 — Predicate, checksums, orchestration (Slice 1 usable release)

**Scope.** Assemble the versioned predicate and human-readable report, compute
checksums with a re-digest guard, wire the whole `signer: none` pipeline in
`main.ts`, publish the predicate schema in-repo, and prove it end-to-end on a
real sample image in CI. This is the first shippable release.

**Tasks.**

- `src/predicate.ts`: **`PREDICATE_TYPE`** constant =
  `https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1`
  (an opaque, versioned identifier — no live endpoint is stood up).
  `buildStatement(state)` assembles the in-toto statement (subject = disk name +
  `state.disk.sha256`) and the predicate: `artifact`, optional
  `incusMetadata.sha256` (from `state.metadata`) and `buildManifest.sha256`
  (from `state.buildManifest`), `tools` from `toolVersions()`, `operatingSystem`
  from `state.fsView`, `sbom` from `state.sbom`, `vulnerabilities` from
  `state.vuln`, `checks`/`policy` from `state.contamination`, overall `result`,
  and `workflow` from `workflowContext()`. It also writes a human-readable
  `validation-report.json` that flattens the predicate and additionally carries
  `incusMetadata.properties` (the raw object from `state.metadata`, kept out of
  the digest-only predicate field). `result` is `fail` if any check fails,
  metadata is invalid, or `thresholdExceeded`. Writes
  `validation-predicate.json` and `validation-report.json`.
- `src/checksums.ts`: `writeChecksums(files, diskPath, expectedDiskSha256)` —
  write a `sha256sum -c`-compatible `checksums.txt` over the disk, optional
  metadata + build manifest, and every evidence file (digests via
  `hash.sha256File`); **re-digest the input disk and fail if it differs from
  `expectedDiskSha256`** (the stage-2 `state.disk.sha256`).
- `docs/predicate/vm-image-validation-v1.md` (human schema) and
  `docs/predicate/vm-image-validation-v1.schema.json` (JSON Schema whose `$id`
  equals `PREDICATE_TYPE` verbatim). These are plain in-repo docs — no GitHub
  Pages or publish workflow is added; reviewers read them at their GitHub blob
  URL.
- `src/main.ts`: after `parseInputs()`, load the contamination policy
  (`loadPolicy`) and, when set, compute `state.buildManifest.sha256` via
  `hash.sha256File`; then run stages 2–9 in order on the shared `state` object,
  passing the fixed evidence basenames (`OUTPUT_FILES` constants declared here,
  joined onto `output-directory`, default `./evidence`) into each stage; set
  every output; wrap in `try/finally` draining the `CleanupRegistry`;
  `core.setFailed` on any throw. Leave a `signer === 'none'` early skip where
  Phase 5 inserts signing.
- `.github/workflows/integration.yml` (`ubuntu-24.04`,
  `permissions: { contents: read }`): build the action and generate a tiny QCOW2
  at test time. The image must survive the pipeline's own fail-closed rules, so
  a bare mkfs filesystem is not enough: `qemu-img create` + guestfish populate
  an ext4 root that libguestfs OS inspection recognizes — a minimal Debian-style
  layout with `/etc/os-release`, the usual top-level directories, and a small
  dpkg database (`/var/lib/dpkg/status`) listing a handful of packages, at least
  one of them an old version with known high/critical CVEs (feeds the
  threshold-breach job; without the seeded database, stage 3 and the
  zero-component SBOM check in stage 5 abort by design). Run the action with
  `signer: none` (positive job uses `fail-on-severity: none` so the seeded CVEs
  do not fail it), and assert all evidence files exist under `./evidence`, every
  report carries the input digest, `sha256sum -c evidence/checksums.txt` passes,
  and the input disk is byte-identical afterward. Negative jobs: corrupt input
  and non-QCOW2 input fail clearly; the seeded high-severity finding with
  `fail-on-severity: high` fails the run. Pin all third-party actions by full
  commit SHA.
- Tests: `__tests__/predicate.test.ts` (snapshot from fixture state; `result`
  logic; `PREDICATE_TYPE` string-equals the `$id` in
  `vm-image-validation-v1.schema.json`; `validation-report.json` carries
  `incusMetadata.properties`), `__tests__/checksums.test.ts` (format +
  digest-changed failure), `__tests__/main.test.ts` (updated: stage ordering,
  outputs set, cleanup drains on both success and thrown-stage paths).

**Dependencies.** Phases 1–3.

**Success criteria.**

- `moon run root:check` green with `dist/` committed.
- `integration.yml` passes on `ubuntu-24.04`: SBOM, vulnerability report,
  checksums, and predicate exist; all three reports carry the input digest;
  `sha256sum -c evidence/checksums.txt` succeeds; pre/post disk SHA-256
  identical.
- Negative integration jobs fail with distinct messages for corrupt input,
  non-QCOW2 input, and threshold breach.
- A unit test asserts `PREDICATE_TYPE` string-equals the `$id` field of
  `docs/predicate/vm-image-validation-v1.schema.json`.

---

## Phase 5 — `signer: github` (completes v1)

**Scope.** Add GitHub-native attestation behind the `Signer` interface using the
`@actions/attest` library, emit the three attestation bundles, surface the
returned identifier, and fail with a clear diagnostic when the repository plan
cannot support it. After this phase v1 is complete.

**Tasks.**

- `src/sign/index.ts`: `Signer` interface (`sign(state): Promise<SignResult>`)
  and `selectSigner(inputs)` dispatch keyed on the `signer` input. Dispatch
  **never falls back**: any backend other than `none`/`github` throws a
  diagnostic naming the requested backend (the single post-v1 extension point;
  no stub modules are created for it yet).
- `src/sign/github.ts`: use `@actions/attest` (`attestProvenance`, `attest`) via
  OIDC to produce build provenance for the QCOW2 (and metadata artifact when
  present), an SBOM attestation, and a custom validation attestation from the
  predicate. Each call **always** pushes to GitHub's attestation API; write the
  returned bundles to
  `<output-directory>/attestations/provenance.sigstore.json`,
  `sbom.sigstore.json`, and `validation.sigstore.json`; set
  `attestation-bundle-path` to `<output-directory>/attestations` and
  `attestation-url` to the returned identifier. Plan support is **reactive**:
  wrap the `@actions/attest` calls and, on the specific error the library raises
  when the repository plan cannot issue attestations (private/internal without
  Enterprise Cloud; Enterprise Server), re-throw a diagnostic naming the missing
  capability — no pre-probe, no silent downgrade.
- `src/main.ts`: replace the Phase-4 skip with
  `selectSigner(inputs).sign(state)` when `signer !== 'none'` **and** the
  computed `result` is `pass`, inside the existing `try/finally`. A failing
  result is never signed: the unsigned evidence is written in full, signing is
  skipped with a `core.info` notice, and the action then fails on the
  threshold/contamination result as in Phase 4.
- `README.md`: fill the "Verification" section —
  `sha256sum -c evidence/checksums.txt` (any run) and
  `gh attestation verify disk.qcow2 --repo meigma/attest-vm-image`
  (`signer: github`); document the required caller permissions
  (`id-token: write`, `attestations: write`, `contents: read`) and the
  Enterprise-Cloud requirement.
- `.github/workflows/integration.yml`: add an opt-in job with
  `permissions: { id-token: write, attestations: write, contents: read }`
  running `signer: github` and asserting the three bundles exist and
  `gh attestation verify` passes, guarded so it is a no-op where the plan
  disallows it.
- Tests: `__tests__/sign.test.ts` — `selectSigner` returns the `github` backend
  and, for every other non-`none` value, throws naming that backend (never
  dispatches to a different one); the `github` path calls the mocked
  `@actions/attest` three times with the right predicate/subject; a simulated
  unsupported-plan error from the mock is re-thrown as the documented
  named-capability diagnostic. `__tests__/main.test.ts` gains a case asserting
  no signer is invoked when the predicate `result` is `fail`, even with
  `signer: github`.

**Dependencies.** Phase 4 (predicate + evidence are the signing inputs).

**Success criteria.**

- `moon run root:check` green with `dist/` committed.
- `__tests__/sign.test.ts` asserts no backend ever dispatches to a different one
  and that a simulated unmet prerequisite is re-thrown as a named-capability
  diagnostic rather than downgrading.
- Opt-in integration job produces three bundles and `gh attestation verify`
  succeeds where the plan allows; elsewhere it is skipped, not failed.
- README shows both generation and independent-verification examples.
- All acceptance criteria in the product spec are demonstrably met by the
  integration workflow and unit suite. **v1 complete.**

---

## Post-v1

Slice 3 implements exactly one backend as a single new `src/sign/<backend>.ts`
file behind the existing `Signer` interface, chosen by consumer demand — no
speculative stubs precede it. `signing-key` remains a reference only (file path,
secret name, agent, or KMS URI), never raw key bytes. No interface or predicate
changes are required; a breaking predicate change would mint a `v2` URI and a
new `docs/predicate/vm-image-validation-v2.*` pair, retaining `v1`.
