---
id: 001
title: Bootstrap attest-vm-image
date: 2026-07-20
status: complete
repos_touched: [attest-vm-image]
related_sessions: []
---

## Goal

Bootstrap the new repository (created from meigma/template-actions as
incus-attest-action, renamed to attest-vm-image) and produce the design and
implementation-plan documents for the attest-vm-image GitHub Action from the
user's product spec.

## Outcome

Goal met. The repo exists at meigma/attest-vm-image with the session protocol
set up, and PR #5 landed docs/design.md (546 lines) and docs/plan.md (419
lines) on main via squash merge (commit bd1372c). The docs are the working
inputs for implementation: plan Phases 0-5 constitute v1.

## Key Decisions

- Keep the TypeScript node24 action form instead of the product spec's
  composite-action suggestion -> the template's test/bundle/CI machinery
  (Jest ESM, rollup dist/, moon root:check) is worth more than composite-step
  visibility; tools run via @actions/exec and signer:github uses the
  @actions/attest library rather than nesting actions/attest.
- v1 boundary = product slices 1+2 (portable evidence + signer:github);
  slice 3 (external signing) is post-v1, demand-driven, one backend behind the
  Signer interface.
- Predicate type URI is an opaque versioned identifier; the JSON Schema lives
  in-repo (docs/predicate/, $id must equal PREDICATE_TYPE, unit-tested) — no
  GitHub Pages infrastructure.
- Docs were produced by a 7-agent workflow (Opus 4.8 draft/revise, 4 Sonnet 5
  critique lenses) and hand-verified against the spec and repo afterward.

## Changes

- `docs/design.md` - architecture, interface (spec-verbatim), 10-stage
  fail-closed pipeline, evidence layout, tool pinning, predicate schema,
  signing backends, error handling, testing strategy.
- `docs/plan.md` - phased plan; Phases 0-5 = v1, each with exact file
  placements and checkable success criteria.
- Repo renamed incus-attest-action -> attest-vm-image (GitHub redirect in
  place); local folder moved, remote and worktree links repaired.
- `.agents/skills/` copied (untracked) from the local template-actions
  checkout; journal branch journal/jmgilman created and populated.

## Open Threads

- Plan Phase 0 (template conversion: real action.yml interface, package.json
  identity, remove wait sample, README rewrite) is the next implementation
  step; template placeholders still say template-actions in package.json,
  README.md, moon.yml, SECURITY.md, release-please-config.json.
- Four Dependabot PRs are open (actions/cache, mise-action, @types/node,
  typescript) and untriaged.
- template-actions gitignores .agents/ and the .journal scaffold, so repos
  created from it lack the session skills; consider tracking them in the
  template like template-go does.

## References

- PR #5: https://github.com/meigma/attest-vm-image/pull/5 (squash commit
  bd1372c)
- Product spec: in the user's request of 2026-07-20 (reproduced in the
  workflow args, see NOTES 16:39-17:10 entries)
- Session protocol source of truth: ~/code/ai (synced per .prettierignore
  comment)

## Lessons

- Workflow tool args can arrive in the script as a JSON-encoded string;
  `args.field` then reads undefined and interpolates the literal string
  "undefined" into agent prompts. Parse string-form args and assert required
  fields before spawning agents. The first docs run (wf_0a56cf8c-02d) burned
  ~456k tokens producing spec-blind output caught only via the reviser's
  changes_summary.
- Verify multi-agent revisers against their own change logs: the second run's
  reviser logged a SECURITY.md fix it never applied to the final text.
