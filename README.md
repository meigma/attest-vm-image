# template-actions

Meigma template repository for GitHub Actions written in TypeScript.

The action skeleton comes from GitHub's canonical
[actions/typescript-action](https://github.com/actions/typescript-action)
template (see [UPSTREAM.md](UPSTREAM.md)), rebased onto the Meigma stack:

- **[mise](https://mise.jdx.dev)** manages every tool (Node, moon) with a
  committed, fail-closed `mise.lock`.
- **[moon](https://moonrepo.dev)** is the task runner and CI gate; CI runs
  `moon ci` against `system` binaries that mise puts on PATH.
- **[release-please](https://github.com/googleapis/release-please)** drives
  releases: Conventional Commits → release PR → draft release + protected
  `vX.Y.Z` tag → human publishes → the `vN` major tag advances automatically.
- Pinned-by-SHA workflows with `permissions: {}` defaults, weekly Dependabot,
  dual MIT/Apache-2.0 license.

## Local bootstrap

```sh
mise install
```

`mise.lock` records per-platform URLs and checksums for every tool, and
`settings.locked` makes installation fail closed when a platform lacks a
pre-resolved entry. To bump a tool, edit its version in `mise.toml`, then:

```sh
mise lock --platform linux-x64,linux-arm64,macos-x64,macos-arm64
```

and commit `mise.toml` + `mise.lock` together. (Note: moon's aqua package does
not currently publish a `macos-x64` build, so Intel macOS is not covered by the
lockfile.)

## Common tasks

```sh
moon run root:check       # the full CI gate: format-check, lint, test, check-dist, audit
moon run root:format      # prettier --write
moon run root:lint        # eslint
moon run root:test        # jest
moon run root:package     # rebuild dist/ (cacheable)
moon run root:check-dist  # rebuild dist/ and fail if it differs from the committed copy
moon ci --summary minimal # exactly what CI runs
```

Without moon, the equivalent npm scripts still work: `npm run ci` mirrors
`root:check`, and `npm run all` is the upstream
format/lint/test/coverage/package sweep.

`npm audit` runs inside `root:check`; if new upstream advisories break unrelated
PRs too often, remove `root:audit` from `check.deps` in [moon.yml](moon.yml)
(one line).

## The sample action

The template ships upstream's wait sample: input `milliseconds`, output `time`.
Code lives in `src/`, tests in `__tests__/` with mock fixtures in
`__fixtures__/`.

The bundled action (`dist/index.js`) is **committed** — that is what
`action.yml` executes. The contract: edit `src/`, run `moon run root:package`,
commit `dist/` with your change. CI's `check-dist` task rebuilds the bundle and
fails if the committed copy is stale.

## Releases

1. Merge Conventional Commits to `main`; release-please maintains a release PR.
2. Merging the release PR bumps `package.json`/`CHANGELOG.md` and creates a
   **draft** GitHub release plus the protected `vX.Y.Z` tag.
3. A human inspects and publishes the draft.
4. Publication triggers the Major Version Tag workflow, which force-moves the
   `vN` compatibility tag so `uses: meigma/<repo>@v1` consumers pick up the
   release.

Repo requirements (org-level): `vars.MEIGMA_RELEASE_APP_ID`,
`secrets.MEIGMA_RELEASE_APP_PRIVATE_KEY`, and a protected `v*` tag ruleset with
a bypass for the release app.

If your action pins a paired CLI version in `action.yml`, add
`"extra-files": [{ "type": "generic", "path": "action.yml" }]` to
[release-please-config.json](release-please-config.json) and a
`# x-release-please-version` marker on the input default so releases keep it in
sync.

## After creating a repo from this template

1. `package.json`: `name`, `description`, `homepage`, `repository`, `bugs`.
2. `action.yml`: `name`, `description`, `author`, `branding`, real
   inputs/outputs; replace `src/` + `__tests__/` with your implementation.
3. `release-please-config.json`: `package-name`.
4. `moon.yml`: `project.title` / `project.description`.
5. This README: rewrite for your action (usage example, inputs/outputs table).
6. `SECURITY.md`: advisories URL.
7. Pick a license posture (keep dual MIT/Apache-2.0 or trim).
8. Repo settings: mark squash-only merges, protected `v*` tag ruleset with the
   release-app bypass, Dependabot labels (`dependencies`, `github-actions`,
   `javascript`).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option. Upstream template code is MIT ([LICENSE.upstream](LICENSE.upstream)).
