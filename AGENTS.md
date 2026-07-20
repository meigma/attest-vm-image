# Agent Instructions

- Read [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md) first.
- Tooling is pinned by mise (`mise install`); tasks run through moon.
- The CI gate is `moon run root:check` — it must pass before any commit is
  proposed for review.
- The bundled action `dist/` is committed: after changing `src/`, run
  `moon run root:package` and commit the refreshed `dist/` in the same change.
- Use Conventional Commit subjects; releases are automated by release-please.

<!-- BEGIN ai-protocol -->

# Agent Instructions

This repository's operating protocol lives in `.session.md`.

Before doing substantive work, read `.session.md` in full and follow it. It
covers startup context loading, session setup, session lifecycle, skill loading,
Worktrunk branching, session journaling, file schemas, architecture, and process
expectations.

If `.session.md` is missing, stop and tell the user the session protocol is not
installed correctly.

<!-- END ai-protocol -->

