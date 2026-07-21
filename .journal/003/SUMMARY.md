---
id: 003
title: Manual hosted acceptance and external packaging repair
date: 2026-07-21
status: complete
repos_touched: [attest-vm-image, setup-distrobuilder]
related_sessions: ['002']
---

## Goal

Manually exercise `attest-vm-image` in a disposable Meigma repository using
the real `meigma/setup-distrobuilder` action, report every acceptance case, and
avoid adding a durable test harness. Repair any release-blocking issue found in
the exercised consumer path.

## Outcome

Goal met. The hosted exercise covered 22 cases: 20 passed, one exposed a
non-blocking diagnostic defect, and one found a release-blocking packaging
defect. `setup-distrobuilder` v1.0.0 passed a cold source build, same-key cache
restore, and construction of a real split Ubuntu Noble VM image with
Distrobuilder 3.3.1.

At `attest-vm-image` commit `e49388b`, ordinary external consumption failed
before any step ran because the tracked `.claude -> .agents` symlink had no
committed target. An exact local checkout isolated that packaging problem from
the runtime: real-image inspection, unsigned evidence, failure paths,
CycloneDX/custom policy, three GitHub attestations, four online verifications,
four offline verifications, 22 JSON documents, and 24 retained checksum targets
all behaved as expected.

The packaging blocker was fixed in PR #13 by committing the 11 intended
`.agents/skills` files. A new immutable external-use smoke proved that GitHub
could stage and enter the action. PR #13 was then squash-merged as `1dc6e44`,
local `main` was fast-forwarded, all feature branches/worktrees were removed,
and the disposable repository was deleted.

## Key Decisions

- Use immutable action SHAs in a disposable hosted repository -> this tested
  the actual GitHub download/staging boundary rather than only local action
  execution.
- Check out the exact action commit locally only after external staging failed
  -> this preserved the packaging failure as a finding while allowing the full
  runtime matrix to continue against identical code.
- Keep `.agents/` ignored but force-add the intended protocol payload -> this
  matches the Meigma template convention and excludes unrelated local agent
  state while making `.claude` valid in the committed action archive.
- After the repair, rerun the smallest unresolved acceptance slice -> a
  four-second external-use smoke proved staging and entrypoint execution
  without repeating the already-passing 15-minute runtime matrix.

## Changes

- `.agents/skills/**` - committed 11 repo-local session-protocol files so the
  tracked `.claude -> .agents` link resolves for external action consumers.
- `.journal/003/ACCEPTANCE_REPORT.md` - recorded the complete 22-case manual
  acceptance matrix, evidence audit, timings, findings, and limitations.
- `setup-distrobuilder` - no source change; v1.0.0 was exercised successfully
  through cold install, cache restore, and a real VM build.
- Disposable acceptance repository - temporary workflows were removed and the
  repository was deleted after evidence capture and regression validation.

## Open Threads

- GitHub signing in an unsupported private repository fails safely, but the
  current `Feature not available ... upgrade the billing plan` API message is
  not translated into the action's named plan diagnostic. Extend the classifier
  and repeat that private-plan case.
- The seeded helper image reported architecture `unknown` in the private-plan
  run even though the real Distrobuilder image reported `x86_64`; tighten the
  helper or its assertion.
- Arm64, Ubuntu 22.04 runners, booting the produced VM, and the unimplemented
  external signing backends were outside this acceptance scope.
- No release exists yet. After the remaining diagnostic cleanup, cut the
  initial release and smoke the released major-version tag externally.

## References

- Full report: `.journal/003/ACCEPTANCE_REPORT.md`
- Packaging repair: [PR #13](https://github.com/meigma/attest-vm-image/pull/13)
  (squash commit `1dc6e443c5093c81c46b519eaadbcefa71664346`)
- External staging regression: disposable run `29856005522` at action commit
  `f00c5ca56cbf1dcedf53ee4288d263bf887c146e`
- setup-distrobuilder: `796360886df2d75b60aec6ce344d747fbaee0e00`
  (`v1.0.0`)
- Prior implementation context: `.journal/002/SUMMARY.md`

## Lessons

- A clean working tree does not prove that a tracked symlink's target is in the
  committed archive; inspect `git archive` and exercise a normal external
  `uses:` reference.
- Real hosted consumer tests catch repository-packaging failures that unit,
  integration, and local-checkout tests cannot observe.
- Separating external staging from exact-checkout runtime testing preserves a
  precise failure while still allowing broad acceptance evidence to be
  collected.
