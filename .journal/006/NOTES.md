---
id: 006
title: Start a new work session
started: 2026-07-21
---

## 2026-07-21 19:13 — Kickoff
Goal for the session: Start a fresh journal session; the substantive goal has
not yet been stated.
Current state of the world: The repository's latest main commit is the 1.0.0
release commit, the operator documentation overhaul is complete, and the
session is ready for a new request.
Plan: Wait for the user's request, then choose the smallest useful next step.

## 2026-07-21 19:15 — Goal established
Goal for the session: Add a small, versioned `evidence-manifest.json` handoff
and `evidence-manifest-path` Action output describing the exact input artifacts
and all known evidence produced by unsigned, signed, and evidence-complete
validation-failure runs. Keep publishing and Simple Streams behavior out of
scope.
Current state of the world: Main contains the released v1 Action and its
operator documentation. The existing output layout, checksum contract, signing
bundles, failure behavior, tests, and committed `dist/` bundle must be preserved.
Plan: Trace the current pipeline and failure boundaries, implement the manifest
from explicit pipeline state, add focused tests and reference docs, rebuild
`dist/`, and run `moon run root:check`.

## 2026-07-21 19:28 — Evidence manifest implemented
Implemented the versioned evidence handoff on `feat/evidence-manifest` in commit
`61049a6` (`feat: add evidence handoff manifest`). A completed run now writes
`evidence-manifest.json` and exposes `evidence-manifest-path`. The manifest uses
stable roles/media types, hashes every explicitly listed evidence file from its
actual bytes, includes optional input artifacts and successful signing bundles,
and mirrors the predicate result.

The handoff is written after checksums and signing but before any outputs are
set. Evidence-complete validation failures therefore expose a `result: fail`
manifest without bundles, while pipeline, signing, or manifest-write aborts
expose no outputs. `checksums.txt` retains its exact existing coverage and order;
the later-written evidence manifest and signing bundles remain excluded.

Validation passed: `moon run root:check` (format, lint, 212 tests, dist
reproducibility, audit) and strict `moon run docs:build`. The committed `dist/`
bundle includes the new Action behavior. No Simple Streams, S3, combined Incus
fingerprint, upload, or publishing behavior was added.
