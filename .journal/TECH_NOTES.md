# Technical Notes

<!-- Add compact project-specific technical notes here. Edit freely; this file is not append-only. -->

- v1 (plan Phases 0-5) is implemented and merged (PRs #7-#12, session 002).
  Post-v1 = one external signing backend behind `src/sign/` on real demand.
  Release App credentials are configured and Release Please is healthy; PR #16
  targets 1.0.0 and is green. No release exists yet, so merging #16 and smoking
  the resulting release plus moving `v1` tag remain open.
- docs/design.md + docs/plan.md were DELETED in PR #17 (session 005); the code
  is the spec. `docs/docs/` is the operator-facing Diátaxis set, published via
  Material for MkDocs at https://meigma.github.io/attest-vm-image/. Build it
  strictly with `moon run docs:build`; `.github/workflows/docs-pages.yml` builds
  PRs and deploys main. `docs/docs/reference.md` owns every shared fact behind a
  fixed anchor contract (other docs link, never restate), and its builtin/v1
  JSON must track src/contamination.ts. All doc examples pin @v1 (resolves after
  the first release). gh-attestation facts field-tested with gh 2.94.0: --bundle
  accepts single-object .sigstore.json but still fetches the TUF trust
  root; air-gapped verify needs --custom-trusted-root; non-provenance
  bundles need --predicate-type; non-TTY success prints nothing.
- Manual hosted acceptance (session 003; `.journal/003/ACCEPTANCE_REPORT.md`)
  validated `setup-distrobuilder` v1.0.0 and the full action runtime against a
  real Distrobuilder-built Ubuntu Noble VM. External staging is fixed by PR #13;
  the remaining action defect is that GitHub's current private-plan billing
  rejection is not translated into the named unsupported-plan diagnostic.
- CI gate: `moon run root:check`. dist/ is committed; `check-dist` diffs the
  rebuilt bundle against HEAD, so it only passes after dist/ is committed.
  Audit runs through `scripts/audit.mjs` (strict low threshold + reviewable
  GHSA allowlist, currently empty).
- package.json `overrides` force @sigstore/sign@^5 + @sigstore/bundle@^5
  under @actions/attest to resolve the patched @sigstore/core@^4 (DSSE CVE
  GHSA-jfc7-64v2-mr8c). Drop the override once @actions/attest resolves
  core>=4 natively; `__tests__/attest-deps.test.ts` asserts the lockfile so
  regressions fail in jest.
- Gotchas that recur: `import ... with { type: 'json' }` breaks
  @rollup/plugin-typescript whole-program emit (use createRequire); jest
  require(ESM) needs Node>=24.9 (CI node may lag local); moon ci runs tasks
  concurrently so transient build artifacts must be eslint-ignored;
  GITHUB_TOKEN is not ambient in `uses:` steps (hence the `github-token`
  input defaulting to `github.token`).
- Integration CI (.github/workflows/integration.yml) seeds a jammy-style
  QCOW2 via .github/scripts/make-test-image.sh: os-release + real dpkg
  stanzas (openssl 3.0.2-0ubuntu1 feeds the threshold job) + valid ELF init;
  libguestfs on runners needs `sudo chmod +r /boot/vmlinuz-*` first. The
  corrupt-case dd targets the qcow2 L1 table (0x30000) — guest-data offsets
  pass `qemu-img check`.
- Multi-agent workflow craft (sessions 001+002): parse string-form Workflow
  args before interpolating into prompts; pin subagent models explicitly;
  the highest-value review lens runs the REAL external tools (containers,
  real binaries, real DBs) against the fixtures — mocked tests cannot see
  wrong-API or wrong-format bugs.
- `.agents/skills/` is intentionally tracked even though `.agents/` remains
  ignored: force-add intended protocol updates so `.claude -> .agents` stays
  valid in GitHub's committed action archive. Session-protocol files sync from
  ~/code/ai and are prettier-ignored. All markdown under docs/ must satisfy
  prettier proseWrap: always at 80 columns or `moon run root:check` fails.
