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
