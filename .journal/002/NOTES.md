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
