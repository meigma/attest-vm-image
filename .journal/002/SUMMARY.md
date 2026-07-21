---
id: 002
title: Review design/plan and implement v1 (Phases 0-5)
date: 2026-07-20
status: complete
repos_touched: [attest-vm-image]
related_sessions: ['001']
---

## Goal

Review the design (docs/design.md) and implementation plan (docs/plan.md)
from session 001, fix what the review surfaced, then — after the user enabled
ultracode with full autonomy — implement the entire v1 (plan Phases 0-5)
end-to-end.

## Outcome

Goal met in full. The design review found seven issues (two of which would
have broken Phase 4 as written); all seven were fixed in PR #6. Phases 0-5
then landed as PRs #7-#12, each squash-merged with CI green. v1 is complete
and proven end-to-end: the integration workflow builds a seeded QCOW2 on
ubuntu-24.04, runs the full pipeline (positive, non-qcow2, corrupt, and
threshold cases), and the sign-image job pushed real attestations to
GitHub's API with `gh attestation verify` passing. Final state: 208 unit
tests (~100% coverage), `moon run root:check` green, dist/ committed. No
release has been cut yet (release-please will propose one from the feat
commits).

## Key Decisions

- Never sign a failing validation result (user decision) -> stage 10 runs
  only when `signer != none` AND `result == pass`; unsigned evidence is
  still written in full.
- Resolve the @sigstore/core DSSE CVE (GHSA-jfc7-64v2-mr8c) via package.json
  `overrides` forcing @sigstore/sign@^5 + @sigstore/bundle@^5 -> the API
  surface @actions/attest uses was verified compatible (exports, constructor
  options, v0.3 bundle media type); preferred over an audit allowlist for an
  attestation product. Audit gate keeps `--audit-level=low` via
  scripts/audit.mjs with an (empty) reviewable allowlist.
- `github-token` action input defaulting to `github.token` -> GITHUB_TOKEN
  is NOT ambient in `uses:` steps; the actions/attest input pattern is the
  only way the documented README example works verbatim. Interface is now 10
  inputs (design.md updated).
- Per-phase multi-agent workflows (implement -> 3-lens adversarial verify ->
  fix), subagents pinned to Opus 4.8/Sonnet 5 -> the "fixture realism" lens
  that validates against REAL tools (containers, real binaries, real grype
  DB) repeatedly caught bugs mocked unit tests could not: missing in-session
  guestfish `mount`, corrupt-test dd offset that qemu-img check ignores,
  builtin-policy false positives on stock Ubuntu (dbus machine-id symlink,
  systemd /tmp skeleton), SPDX zero-component bypass via syft's synthetic
  root package.
- Integration test image seeds a jammy-style root (os-release, real dpkg
  stanzas incl. openssl 3.0.2-0ubuntu1 for the threshold job, valid ELF
  init, trailing stanza separator) -> the pipeline's own fail-closed rules
  reject anything less; positive job runs `fail-on-severity: none`.

## Changes

- `docs/design.md` / `docs/plan.md` - review fixes (PR #6): seeded
  integration image, /boot/vmlinuz-* readability fixup, sign-on-fail policy,
  checksums/attestations exclusion, SBOM subject post-processing,
  attestation-url = validation URL, arm64 best-effort note; later
  `github-token` input row (PR #12).
- `action.yml`, `src/inputs.ts`, README - real interface (PR #7).
- `src/{exec,hash,tools,cleanup,context}.ts` - runtime foundation; syft
  1.48.0 / grype 0.116.0 pins with independently verified digests (PR #8).
- `src/{disk,inspect,metadata}.ts` - qemu-img validation, libguestfs
  read-only inspection, tar safety checks incl. symlinked-parent escapes
  (PR #9).
- `src/{sbom,vuln,contamination}.ts` - SBOM subject embedding, scan-error vs
  threshold split, builtin/v1 policy with exclude support (PR #10).
- `src/{predicate,checksums,main}.ts`, `docs/predicate/*`,
  `.github/workflows/integration.yml`, `.github/scripts/make-test-image.sh`
  - full signer:none pipeline + schema pair + integration CI (PR #11).
- `src/sign/{types,index,github}.ts` - github signer, three attestations,
  reactive plan diagnostics, opt-in sign-image job (PR #12).
- `scripts/audit.mjs`, `eslint.config.mjs`, `rollup.config.ts`,
  `package.json` overrides - gate/build hardening along the way.

## Open Threads

- No release cut yet; release-please should have a pending release PR from
  the six feat commits — triage and merge it to publish v0.x.
- Four Dependabot PRs (from session 001) remain open and untriaged (#1-#4).
- Post-v1 slice 3: exactly one external signing backend
  (sigstore-keyless/cosign-key/kms) behind the Signer interface, on real
  consumer demand.
- The sigstore v5 override must be revisited when @actions/attest ships a
  release resolving @sigstore/core >= 4 natively (the lockfile-assertion
  test in __tests__/attest-deps.test.ts guards regressions until then).
- arm64 remains best-effort (no KVM on hosted arm64 runners; TCG fallback).

## References

- PR #6 (docs fixes): https://github.com/meigma/attest-vm-image/pull/6
- PRs #7-#12 (Phases 0-5):
  https://github.com/meigma/attest-vm-image/pull/7 ... /pull/12; squash
  commits 60063ec, 6c7f497, 48c5a10, 6d48fa4, 962ef5d, e49388b.
- Prior session: `.journal/001/SUMMARY.md`.

## Lessons

- The single highest-value review lens is "run the REAL tool and compare":
  it found every bug that mocked-fixture tests structurally cannot see.
  Budget one such lens per phase that touches external tools.
- Workflow tool args can arrive as a JSON string (session-001 lesson
  recurred in the first phase-0 script): always
  `typeof args === 'string' ? JSON.parse(args) : args` and assert required
  fields before interpolating into agent prompts.
- `import ... with { type: 'json' }` under @rollup/plugin-typescript poisons
  whole-program emit with a misleading parse error in an unrelated file; use
  createRequire for package.json reads in bundled actions.
- Jest `require(ESM)` needs Node >= 24.9; CI's pinned node may lag the local
  one — prefer lockfile assertions over ESM smoke-imports for dependency
  guards.
- moon ci runs tasks concurrently: transient build artifacts (rollup's
  compiled config) must be eslint-ignored or lint flakes with ENOENT.
