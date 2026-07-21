# Technical Notes

<!-- Add compact project-specific technical notes here. Edit freely; this file is not append-only. -->

- Implementation is driven by `docs/design.md` + `docs/plan.md` (landed in
  PR #5). Plan Phases 0-5 = v1; pick up the next incomplete phase. The action
  stays a TypeScript node24 action (not composite); `signer: github` uses the
  `@actions/attest` library, not the nested action.
- `.agents/skills/` is untracked here (template-actions gitignores it); it was
  copied from the local template-actions checkout. The session-protocol files
  (`.session.md`, `AGENTS.md`, `CLAUDE.md`) sync from `~/code/ai` and are
  prettier-ignored.
- Repo was created as incus-attest-action and renamed; GitHub redirects the
  old URL. All markdown under `docs/` must satisfy prettier
  `proseWrap: always` at 80 columns or `moon run root:check` fails.
