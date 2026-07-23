# Technical Notes

<!-- Add compact project-specific technical notes here. Edit freely; this file is not append-only. -->

- v1 (plan Phases 0-5) landed in PRs #7-#12 (session 002). v1.2.0 adds
  `cosign-key`, `sigstore-keyless`, and `kms` through one shared Cosign engine
  (session 007, PRs #22-#25). v1.3.0 adds the credential-isolated sign-only
  companion action `meigma/attest-vm-image/sign@v1` (session 008, PR #27).
  `v1`, `v1.3.0`, and `main` point to release commit `34388fd`; Release Please
  creates a draft and publication advances `v1`.
- Sign-only action (session 008): `sign/action.yml` -> `../dist/sign/index.js`
  (second rollup bundle; the config exports an array and MUST stay
  annotation-free JS — tsconfig `include` skips it so `--configPlugin` passes
  it through unparsed). It consumes `evidence-manifest.json`, re-verifies
  fail-closed (schema, pass result, unsigned, exactly the five core roles,
  basename resolution against the manifest dir, per-file digest re-hash,
  statement-subject == disk digest), signs via the unchanged engine, and
  promotes the manifest atomically. Signers use digests only — the image never
  crosses the job boundary. `src/tools.ts` resolves package.json nearest-first
  from both bundle depths; `scripts/smoke-dist.mjs` (run inside the check-dist
  npm script, NEVER jest — moon runs test/check-dist concurrently and
  check-dist rimrafs dist/ mid-rebuild) executes both bundles as the runner
  would. eslint `maximumDefaultProjectFileMatchCount` is sized exactly to the
  allowDefaultProject file count (30); bump it when adding test/script files.
  Prettier de-indents YAML fragments in markdown fences — write workflow
  examples self-contained from `jobs:`. Reusable-workflow layer for keyless
  trusted-builder identity deliberately deferred (user prefers the two-job
  action pattern).
- External signer contract: all three backends sign complete provenance, SBOM,
  and validation statements and self-verify before atomic promotion. Keyless
  requires GitHub OIDC, exact identity/issuer, and one public Rekor entry. Key
  and KMS modes disable Fulcio, ambient OIDC, Rekor, and timestamp services and
  leave attestation URLs unset.
- KMS accepts immutable AWS ARNs, explicit GCP/Azure versions, and Vault/OpenBao
  Transit keys with ambient credentials. AWS `ECC_NIST_P256` was live-tested;
  GCP, Azure, Vault, and OpenBao remain field-test pending. There is deliberately
  no persistent cloud canary because no reliable CI account exists; keep the
  account-free tests and `.journal/007/SLICE3_AWS_KMS_CANARY_REPORT.md`.
- docs/design.md + docs/plan.md were DELETED in PR #17 (session 005); the code
  is the spec. `docs/docs/` is the operator-facing Diátaxis set, published via
  Material for MkDocs at https://meigma.github.io/attest-vm-image/. Build it
  strictly with `moon run docs:build`; `.github/workflows/docs-pages.yml` builds
  PRs and deploys main. `docs/docs/reference.md` owns every shared fact behind a
  fixed anchor contract (other docs link, never restate), and its builtin/v1
  JSON must track src/contamination.ts. All doc examples pin the released `@v1`
  compatibility tag. gh-attestation facts field-tested with gh 2.94.0: --bundle
  accepts single-object .sigstore.json but still fetches the TUF trust
  root; air-gapped verify needs --custom-trusted-root; non-provenance
  bundles need --predicate-type; non-TTY success prints nothing.
- Manual hosted acceptance (session 003; `.journal/003/ACCEPTANCE_REPORT.md`)
  validated `setup-distrobuilder` v1.0.0 and the full action runtime against a
  real Distrobuilder-built Ubuntu Noble VM. External staging is fixed by PR #13.
  Common private-plan rejections receive the named unsupported-plan diagnostic;
  the real-world `Feature not available` / `upgrade the billing plan` variant
  still surfaces unchanged and remains documented.
- CI gate: `moon run root:check`. dist/ is committed; `check-dist` diffs the
  rebuilt bundle against HEAD, so it only passes after dist/ is committed.
  Audit runs through `scripts/audit.mjs` (strict low threshold + reviewable
  GHSA allowlist, currently empty). Run the gate from an implementation worktree
  or clean export: main's nested `.wt/journal-*` can be traversed by ESLint/Jest
  and exceed typescript-eslint's default-project limit.
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
  input defaulting to `github.token`); Cosign v3 may omit an empty
  `verificationMaterial.tlogEntries` field instead of emitting `[]`.
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
