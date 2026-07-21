---
id: 003
title: New work session
started: 2026-07-21
---

## 2026-07-21 09:27 — Kickoff

Goal for the session: Start a new journal session; the substantive work goal
has not yet been provided.

Current state of the world: v1 is implemented and merged through PR #12, the
main checkout is clean at e49388b, and no release has been cut yet.

Plan: Await the user's request, take the next smallest useful slice, and
checkpoint meaningful progress in this session.

## 2026-07-21 09:39 — Manual acceptance test scoped

The user requested a thorough manual, hosted acceptance test of
attest-vm-image using a disposable public repository under `meigma`, with the
real `meigma/setup-distrobuilder` action building the QCOW2 input. No durable
test harness should be added; the deliverable is a full case-by-case report.

Pinned acceptance targets: attest-vm-image main at
`e49388b52d8912801515bcc86c862901b4037087`; setup-distrobuilder release
`v1.0.0` at `796360886df2d75b60aec6ce344d747fbaee0e00` (the current major tag
points to the same commit). Both are public and the authenticated user has
admin access.

Plan: prove the smallest real Distrobuilder image path first, then expand to
unsigned evidence, GitHub signing, alternate SBOM/custom-policy behavior, and
representative fail-closed/evidence-complete paths. Download and inspect the
actual artifacts and attestation records before deleting the temporary repo.

## 2026-07-21 10:32 — Manual acceptance complete

The hosted acceptance matrix is complete and the full case-by-case report is in
`ACCEPTANCE_REPORT.md`.

The primary result is a release blocker: a normal external consumer cannot
stage attest-vm-image at `e49388b` because tracked `.claude` points to ignored,
untracked `.agents`. GitHub fails the job during action staging before any step
runs. Checking out the exact commit and invoking it locally bypassed only that
packaging failure; the runtime then passed real Distrobuilder image inspection,
unsigned evidence, expected fail-closed/evidence-complete paths, CycloneDX and
custom policy, three GitHub attestations, and four online plus four offline
claim verifications.

setup-distrobuilder `v1.0.0` passed a genuine external cold source build,
same-key cache restore, and a real split Ubuntu Noble VM build. A private-repo
follow-up found that signing fails safely on the Meigma plan but GitHub's current
`Feature not available ... upgrade the billing plan` error is not recognized by
the action's promised named-plan diagnostic classifier.

No product source was changed. Raw hosted logs and artifacts were downloaded
before temporary-repository teardown. The local temporary checkout was moved to
Trash. The remote repository remains private because GitHub requires sudo-mode
security-key reauthentication for deletion; the browser is left at that
account-holder handoff.

## 2026-07-21 11:12 — External packaging blocker fixed

The user confirmed that `.agents` is intended committed repository content and
asked for the acceptance blocker to be fixed. The minimal repair is commit
`f00c5ca56cbf1dcedf53ee4288d263bf887c146e` on
`feat/commit-agent-skills`: it force-adds the 11 audited session-protocol files
under `.agents/skills` while preserving the template's `.agents/` ignore rule
for unrelated local runtime state. The files match `~/code/ai` and
`template-go` byte-for-byte; `.gitignore`, source, and `dist/` are unchanged.

Local `moon run root:check` passed all seven tasks and 208 tests. Extracting a
real `git archive` proved that it now contains all 11 files and that the tracked
`.claude -> .agents` symlink resolves inside the archive.

The exact external-consumer regression passed in disposable-repository run
`29856005522`: GitHub staged
`meigma/attest-vm-image@f00c5ca56cbf1dcedf53ee4288d263bf887c146e`,
entered the bundled action, produced its expected output directory, and then
hit only the deliberately missing-manifest error. The temporary smoke workflow
was removed immediately afterward. PR #13 is ready for review with CI,
build-image, sign-image, and Kusari Inspector all green.
