---
id: 002
title: Review design and implementation plan
started: 2026-07-20
---

## 2026-07-20 18:40 — Kickoff
Goal for the session: review the design (docs/design.md) and implementation
plan (docs/plan.md) produced in session 001.
Current state of the world: repo bootstrapped as meigma/attest-vm-image; PR #5
landed docs/design.md and docs/plan.md on main (squash commit bd1372c). Plan
Phases 0-5 constitute v1; no implementation has started (Phase 0 template
conversion is the next step). Four Dependabot PRs remain open and untriaged.
Plan: read both docs in full, review them against the repo state and the
session-001 decisions, and report findings to the user.

## 2026-07-20 18:50 — Design/plan review findings
Read docs/design.md and docs/plan.md in full; verified repo state matches
Phase 0 assumptions (wait.ts/tests/fixtures present, template placeholders in
action.yml, package.json, moon.yml, SECURITY.md, release-please-config.json,
README.md).
Findings, by severity:
1. Phase 4 integration test image conflicts with fail-closed rules: a bare
   mkfs QCOW2 has no OS/package DB, so stage 3 (inspection) and stage 5
   (zero-component SBOM) abort. Test image must seed /etc/os-release, a
   minimal dpkg status DB (with an old pkg for the threshold-breach job), and
   an inspectable root.
2. libguestfs on Ubuntu runners needs readable /boot/vmlinuz-* (not
   world-readable by default); neither doc handles it. Belongs in
   ensureAptPackages() or workflow docs.
3. checksums.txt layout comment claims it covers attestations/, but stage 9
   (checksums) precedes stage 10 (signing) — clarify exclusion.
4. Unspecified whether stage 10 signs when result:"fail" (threshold breach /
   contamination) — decide before Phase 4/5 wire main.ts.
5. Syft directory source cannot natively set an arbitrary subject digest;
   embedding disk sha256 likely needs SBOM post-processing.
6. attestation-url is one output for three attestations — pick which.
7. arm64 pins present but hosted arm64 runners lack KVM (TCG fallback, slow).
Next: report to user; likely follow-up is a small docs PR amending plan
Phase 4 (+design tool-acquisition note) before Phase 0 starts.

## 2026-07-20 19:05 — Docs PR for review items 1, 2 (+ sign-on-fail decision)
User decided: never sign when result is "fail". Opened PR #6
(docs/integration-image-libguestfs branch) amending docs/design.md and
docs/plan.md:
- Phase 4 / testing strategy: integration image must be an inspectable
  minimal Debian-style root (/etc/os-release, dpkg status DB with one old
  CVE-bearing package); positive job runs fail-on-severity: none.
- Phase 1 / tool acquisition: ensureAptPackages() chmods /boot/vmlinuz-*
  readable after install (supermin needs it as non-root), fails closed;
  tools.test.ts asserts it.
- Stage 10 / Phase 5: signing skipped when result is "fail"; main.test.ts
  gains a no-sign-on-fail case; evidence layout comment updated.
moon run root:check green after prettier --write. Remaining review items
(3 checksums/attestations wording, 5 SBOM subject digest, 6 attestation-url,
7 arm64 note) not yet addressed. Awaiting PR merge.

## 2026-07-20 19:20 — Items 3, 5, 6, 7 folded into PR #6
Second commit (98a6370) on the same branch addresses the remaining review
items:
- 3: checksums.txt explicitly excludes attestations/ (stage 9 text, layout
  comment, plan Phase 4 checksums bullet).
- 5: sbom.ts post-processes the emitted SBOM JSON to stamp the disk digest
  (SPDX root-element checksum / CycloneDX metadata.component hash) before
  computing the file's own digest (design stage 5, plan Phase 3).
- 6: attestation-url carries the validation attestation's URL; other two URLs
  go to the workflow log (outputs table, github signer section, plan Phase 5).
- 7: arm64 pins are best-effort — hosted arm64 runners lack KVM, TCG fallback
  (design tool-acquisition intro).
moon run root:check green; PR #6 body updated. All seven review findings are
now addressed; awaiting merge, then Phase 0.

## 2026-07-20 19:25 — PR #6 merged
Checks (ci, Kusari Inspector) green; squash-merged as 04705d4 on main. Local
main fast-forwarded; docs/integration-image-libguestfs worktree and branch
removed. All seven review findings from this session are now landed in
docs/design.md and docs/plan.md. Next step: plan Phase 0 (template
conversion).

## 2026-07-20 19:35 — Ultracode: begin phased implementation
User enabled ultracode and granted full autonomy to execute plan Phases 0-5
end-to-end (small workflows; subagents pinned to Opus 4.8/Sonnet 5, never the
session model). Per-phase loop: worktree from main -> workflow (implement ->
3-lens adversarial verify -> fix) -> commit -> PR -> checks -> squash merge.
Phase 0 worktree feat/phase0-template-conversion created; baseline root:check
green; workflow wf_d7a4bf13-6b4 launched.

## 2026-07-20 20:15 — Phase 0 merged (PR #7)
Workflow wf_d7a4bf13-6b4 implemented Phase 0; review restored root:audit with
scoped allowlist. Kusari then flagged the allowlisted GHSA-jfc7-64v2-mr8c
(DSSE type-binding CVE in @sigstore/core@2 via @actions/attest) as fixable:
resolved properly via package.json overrides forcing @sigstore/sign@^5 +
@sigstore/bundle@^5 (API surface verified compatible: same named exports,
constructor options, v0.3 bundle media type) -> @sigstore/core@4.0.1; audit
allowlist now empty. Jest ESM-import smoke test failed on CI (require(ESM)
needs Node 24.9+); replaced with lockfile version assertions. PR #7 squash-
merged. Lesson: workflow args arrived as JSON string -> ${WT} interpolated as
"undefined" in agent prompts (session-001 lesson recurred); agents recovered
via branch name. Parse string args in all future workflow scripts.

## 2026-07-20 20:55 — Phase 1 implemented (PR #8)
Workflow wf_e3dd862d-e7b: researcher pinned syft 1.48.0 / grype 0.116.0
(digests computed locally, cross-checked vs published checksums.txt, then
independently re-downloaded and re-verified by a review lens — zero findings).
Implementer's `import pkg from '../package.json' with { type: 'json' }`
poisoned @rollup/plugin-typescript whole-program emit (misleading error
pointing at main.ts); one reviewer misdiagnosed it as a pre-existing
toolchain break, fixer proved otherwise and swapped to createRequire.
dist/ unchanged (modules not yet reachable from entrypoint). root:check
fully green incl. check-dist; 48 tests, 100% coverage. PR #8 open.

## 2026-07-20 21:50 — Phase 2 implemented (PR #9)
Workflow wf_2dd18ae8-a29. Realism review lens earned its keep: built a real
Ubuntu 24.04 image + libguestfs and proved the guestfish chain was missing an
in-session `mount` before inspect-list-applications2 (would have failed on
every real disk — invisible to mocked unit tests). Also caught: symlinked-
parent tar escape admitted by lexical-only check (fixed via declared-symlink
parent tracking), GNU tar device major,minor has no space, sockets can't
appear in tar (replaced dead branch with fail-closed type whitelist),
qemu-img info always emits children[], corruptions-fixed only appears with
-r. All 8 findings fixed; 90 tests, 100% coverage; dist/ unchanged. PR #9.

## 2026-07-20 22:40 — Phase 3 implemented
Workflow wf_e47b2d3f-ff6. Realism lens ran the REAL pinned syft/grype
binaries (+ real grype DB): grype 0.116.0 descriptor.db is nested under
.status (fixtures were flat-shape); syft SPDX has no documentDescribes
(relationships-only) and omits components key when empty. Spec lens caught
SPDX zero-component check bypass via syft's synthetic DocumentRoot package.
Gates lens caught two builtin-policy false-positive traps on real Ubuntu:
/var/lib/dbus/machine-id is a symlink (path-exists->non-empty-file) and
/tmp/** matches systemd skeleton (added exclude support). 7/7 findings
fixed; 164 tests. PR #10 opened, checks running in background.

## 2026-07-20 23:45 — Phase 4 merged (PR #11), integration green first try
Workflow wf_7e297ec6-0d2. Full signer:none pipeline wired; predicate schema
pair landed; integration.yml built the seeded jammy image and all four cases
(positive, non-qcow2, corrupt, threshold) passed on ubuntu-24.04 on the
FIRST CI run (4m19s) — the empirical review pass paid off (corrupt-case dd
retargeted from guest-data offset 1M to the qcow2 L1 table at 0x30000 after
container verification that qemu-img check ignores guest-data damage; dpkg
trailing-stanza separator; ELF init so arch resolves). dist/ now bundles
the real pipeline. Phase 5 (github signer) worktree created.

## 2026-07-21 00:40 — Phase 5 merged (PR #12). v1 COMPLETE.
Workflow wf_d5b0e089-5d2. attest-api review lens read the real
@actions/attest 3.2.0 source and caught the launch blocker: GITHUB_TOKEN is
NOT ambient in uses: steps — fixed with a github-token input defaulting to
github.token (actions/attest pattern; design.md inputs table updated to 10
inputs). Other fixes: GITHUB_SERVER_URL-derived attestation-url, SPDX
predicateType derived from spdxVersion, dead 403/404 regex arm removed
(octokit flattens status), fork-PR guard on sign-image job. Bundling
@actions/attest needed inlineDynamicImports (optional kerberos import).
PR #12 checks: ci, Kusari, build-image (integration), AND sign-image — real
attestations pushed and gh attestation verify PASSED. Squash e49388b.
All of plan Phases 0-5 landed as PRs #7-#12; v1 acceptance demonstrated by
the integration workflow + 208-test unit suite. Post-v1 items: one external
signing backend on demand; release via release-please (no release cut yet).

## 2026-07-21 00:55 — Close
Session closed. All work merged: PR #6 (design/plan review fixes) and PRs
#7-#12 (plan Phases 0-5, squash commits 60063ec, 6c7f497, 48c5a10, 6d48fa4,
962ef5d, e49388b). v1 complete and proven by integration + sign-image CI
jobs (real attestations, gh attestation verify green). Local main
fast-forwarded to e49388b; all implementation worktrees removed. SUMMARY.md
written; TECH_NOTES.md updated with durable context (overrides, gotchas,
integration-image requirements, workflow craft). Hand-off: triage the
release-please release PR and the four open Dependabot PRs (#1-#4); post-v1
slice 3 awaits consumer demand.
