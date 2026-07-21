---
id: 005
title: Operator docs overhaul (Diátaxis)
date: 2026-07-21
status: complete
repos_touched: [attest-vm-image]
related_sessions: ['002', '003']
---

## Goal

Replace the antiquated docs/ (design.md, plan.md) with a small, high-quality,
operator-facing documentation set following Diátaxis, written by a multi-agent
workflow (Opus draft/revise, Sonnet critique lenses), with a user-approved plan
before any writing.

## Outcome

Goal met. PR #17 (squash commit `b4c4558`) deleted design.md and plan.md and
landed seven new docs plus a slimmed README (+2026/-1120 over 10 files):
getting-started tutorial, four how-tos (signing, verification,
validation-policy, troubleshooting), one canonical reference, one how-it-works
explanation. docs/predicate/ was kept (schema `$id` is unit-test-asserted).
CI green, merged with user approval, local main fast-forwarded, worktree and
branches cleaned up.

## Key Decisions

- Plan-first with adversarial critique -> a 3-lens Sonnet panel reviewed the
  draft plan before the user saw it; its blocking fixes (tutorial ends before
  signing; error catalog lives in reference.md, not troubleshooting.md)
  shaped the final structure.
- Single fact ownership -> reference.md owns all shared facts (attestation
  table, error catalog, requirements, builtin policy as ONE copy-pasteable
  JSON block); other docs link to fixed anchors. validation-policy.md owns
  matcher shapes; how-it-works.md owns all rationale prose.
- Field-test before writing -> an Opus agent empirically proved every
  gh attestation command against real attestations (cli/cli assets) before
  verification.md was drafted; the doc marks its one untested variant.
- Tutorial reliability -> `fail-on-severity: none` + the CI-proven seeded
  guestfish image so every learner's first run passes; README quotes the
  tutorial's YAML byte-identical.
- All `uses:` examples pin `@v1` -> matches the in-flight v1.0.0 initial
  release; will not resolve until that release publishes (user merged with
  this caveat surfaced).

## Changes

- `docs/{getting-started,signing,verification,validation-policy,troubleshooting,reference,how-it-works}.md`
  - the new seven-doc set (2026 lines).
- `README.md` - slimmed to intro, two minimal examples, requirements teaser,
  and a documentation index; stale status banner and duplicated tables
  removed.
- `docs/design.md`, `docs/plan.md` - deleted.

## Open Threads

- `@v1` in every example resolves only once the v1.0.0 release (session 004,
  in flight) publishes and major-version-tag.yml creates the tag.
- The untranslated "Feature not available ... billing plan" signing rejection
  is now documented as-is (reference.md failure catalog, troubleshooting.md);
  the code-side classifier fix remains open from session 003.
- Online `gh attestation verify` of the custom validation predicate type
  (without `--bundle`) is documented as expected-but-not-live-verified;
  worth a one-off check after the first signed release.

## References

- PR #17: https://github.com/meigma/attest-vm-image/pull/17 (squash commit
  `b4c4558`)
- Approved plan spec: session scratchpad `doc-plan-final.md` (fact-ownership
  map and reference.md anchor contract are restated in the PR body and docs)
- Workflows: survey `wf_d9ab38d3-20a` (5 readers), plan critique
  `wf_d3584faa-91e` (3 lenses), writing `wf_fef701af-18a` (36 agents,
  field-test findings in `.journal/005/NOTES.md` 16:05 entry)
- Prior context: `.journal/003/SUMMARY.md` (acceptance findings the docs
  encode), `.journal/002/SUMMARY.md` (v1 implementation)

## Lessons

- Field-testing commands before documenting them pays off: the gh
  attestation trust-root behavior (`--bundle` still fetches TUF; air-gapped
  needs `--custom-trusted-root`; non-provenance bundles need
  `--predicate-type`; non-TTY success prints nothing) was all discoverable
  only empirically and would otherwise have shipped wrong or vague.
- moon caches task results per content hash and can return a 6-second
  "green" from another worktree's state; verify `pwd` before trusting a
  fast root:check pass.
- Writing the reference doc FIRST with a fixed anchor contract lets six
  sibling docs link to it while being drafted in parallel without races.
