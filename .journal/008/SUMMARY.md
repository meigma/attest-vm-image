---
id: 008
title: Credential-isolated sign-only companion action
date: 2026-07-23
status: complete
repos_touched: [attest-vm-image]
related_sessions: ['007']
---

## Goal

Assess the user's concern that signing credentials (most pointedly KMS) are
live in the job environment throughout the long untrusted-image parsing
pipeline, and — after the assessment confirmed the risk — design, implement,
and release a mitigation the user chose: a sign-only mode enabling a two-job
split, in preference to a reusable workflow.

## Outcome

Goal met. The assessment confirmed the exposure (ambient signing capability
co-resident with stages 2-9 parsing of attacker-influenced input; worst for
`cosign-key`, transient-oracle for `kms`, transparency-logged for keyless).
PR #27 added the `meigma/attest-vm-image/sign@v1` companion action; release
PR #28 published v1.3.0. `v1`, `v1.3.0`, and `main` all resolve to `34388fd`,
and the `v1` tag verifiably ships `sign/action.yml` plus `dist/sign/index.js`,
so the sign action and every merged `@v1` doc example are live. All unit,
integration (including the new `sign-evidence` job), docs, and release-commit
workflows passed; branches and worktrees were cleaned up.

## Key Decisions

- Sign-only companion action over a reusable workflow -> the user judged the
  reusable workflow less ergonomic; it remains a possible later layer for
  keyless trusted-builder identity (`job_workflow_ref` pinning).
- Subdirectory action `sign/action.yml` with its own `dist/sign/index.js`
  bundle -> keeps the main action's contract untouched (no mode-conditional
  `disk-path`) and gives the sign job a minimal input surface.
- Sign from digests, never image bytes -> the signers already embed
  precomputed digests, so only the evidence directory crosses the job
  boundary; `disk-path` is an optional extra re-check. Proven empirically:
  the CI sign job runs in ~11s versus ~5.5m for validation.
- Fail-closed handoff re-verification before any signing tool runs -> schema,
  passing result, unsigned manifest (re-signing refused), exactly the five
  core roles with unique basenames resolved against the manifest's own
  directory, per-file digest re-hash, and statement-subject/disk cross-check.
- Reuse the existing signing engine unchanged behind `selectSigner` -> shared
  `validateSigningInputs` extracted from `src/inputs.ts` so the two
  entrypoints cannot drift; manifest promotion is atomic (temp + rename).
- Document the boundary honestly -> job separation protects the key/oracle;
  it cannot make evidence content trustworthy against a compromised validate
  job. Stated plainly in the how-to and how-it-works.
- Bundle smoke test lives inside `check-dist`, not jest -> `moon check` runs
  test and check-dist concurrently and check-dist deletes `dist/` mid-rebuild,
  so a jest variant races.

## Changes

- `src/sign-only/{inputs,verify,main,index}.ts`, `sign/action.yml` - the
  companion action: input contract, fail-closed handoff verification, signing
  dispatch, atomic manifest promotion.
- `src/inputs.ts`, `src/sign/index.ts` - extracted shared
  `validateSigningInputs`; `selectSigner` narrowed to a `SignerSelection`
  pick (no behavior change).
- `src/tools.ts` - package.json now resolves nearest-first from both bundle
  depths; the old one-level assumption crashed `dist/sign/index.js` at load
  (caught by CI, invisible to unit tests).
- `rollup.config.ts`, `moon.yml`, `package.json`, `scripts/smoke-dist.mjs`,
  `eslint.config.mjs` - second bundle, smoke-test wired into `check-dist`,
  default-project file cap bumped to 30.
- `__tests__/sign-only-{verify,inputs,main}.test.ts` - 34 new tests (296
  total): tamper/refusal matrix, input contract, orchestration atomicity.
- `.github/workflows/integration.yml` - `build-image` uploads unsigned
  evidence; new `sign-evidence` job proves tamper refusal, cosign-key signing
  with offline verification, and re-sign refusal.
- `docs/docs/credential-isolation.md` (new how-to), `reference.md` (Sign
  action section: inputs/outputs/handoff verification/failure catalog),
  `how-it-works.md` (Why signing can move to a separate job), plus
  signing.md/index.md/mkdocs.yml/README cross-links.
- `dist/` - both committed bundles refreshed.

## Open Threads

- Reusable workflow layer for keyless trusted-builder identity deferred by
  user choice; the sign action design leaves it layerable later.
- Carried from 007: GCP/Azure/Vault/OpenBao KMS remain field-test pending;
  the private-plan billing rejection is still unclassified; both release
  workflows still use the deprecated `app-id` input for
  `actions/create-github-app-token`.
- The release-commit Integration run stalled ~50 min on a wedged runner
  (first step, no log blob); cancel + rerun of the same commit went green.
  One-off infrastructure, but the diagnosis pattern is recorded in Lessons.

## References

- Proposal: `.journal/008/SIGN_ONLY_MODE_PROPOSAL.md`
- [PR #27: sign-only companion action](https://github.com/meigma/attest-vm-image/pull/27)
- [PR #28: v1.3.0 release](https://github.com/meigma/attest-vm-image/pull/28)
- [v1.3.0 release](https://github.com/meigma/attest-vm-image/releases/tag/v1.3.0)
- Prior context: `.journal/007/SUMMARY.md` (external signing backends)

## Lessons

- A subdirectory action's bundle depth is part of its runtime contract:
  relative `createRequire` paths that work from `dist/index.js` break from
  `dist/sign/index.js`. Smoke-execute every committed bundle the way the
  runner does; unit tests cannot see bundle-layout failures.
- Anything that reads committed `dist/` must not run under jest in this repo:
  `moon check` runs `root:test` and `root:check-dist` concurrently and
  check-dist rimrafs `dist/` mid-rebuild. Sequential placement inside the
  check-dist script is the race-free home.
- `rollup.config.ts` must stay annotation-free JavaScript — tsconfig
  `include` does not cover it, so `--configPlugin` passes it through
  unparsed and TS annotations break Rollup's parser.
- The eslint `maximumDefaultProjectFileMatchCount` is sized exactly to the
  `allowDefaultProject` file count; adding test or script files requires
  bumping it in the same change.
- Prettier reformats YAML inside markdown fences and de-indents job
  fragments to column 0; write workflow examples as self-contained blocks
  starting at `jobs:`.
- A release-commit workflow hung on its first step with no log blob
  available is runner infrastructure, not code: cancel and rerun the same
  immutable commit instead of diagnosing the tree.
