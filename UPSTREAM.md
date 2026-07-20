# Upstream template provenance

This template started from GitHub's canonical TypeScript action template:

- Repository: <https://github.com/actions/typescript-action>
- Commit: `57b9acc0d972b482f0db345fa09703f3612fda95`
- Imported: 2026-07-20
- License notice: [`LICENSE.upstream`](LICENSE.upstream)

The initial import retained the template's Node 24 ESM runtime, TypeScript and
Rollup configuration, Jest setup, ESLint/Prettier policy, wait sample action,
fixture pattern, and committed distribution-bundle model.

The template's repository-level workflows, release script, local-action
development utility, devcontainer, editor settings, Copilot prompt files, and
license-compliance tooling were not imported. The unused local-action dependency
also carried avoidable vulnerable transitive packages at import time. CI,
tooling, and the release process were replaced with the Meigma stack: mise
(locked toolchain), moon (task runner / CI gate), and release-please (draft
releases + major-tag automation).

This is a pinned source baseline, not a merge-tracked fork. Future template
updates should be reviewed and imported deliberately.
