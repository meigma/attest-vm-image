---
id: 007
title: Start a new work session
started: 2026-07-21
---

## 2026-07-21 21:53 — Kickoff

Goal for the session: Start a fresh journal-backed work session; the substantive
goal has not been provided yet.

Current state of the world: `main` is clean at the v1.1.0 release commit
`2646b5c`. Recent closed work covered hosted acceptance, initial release
preparation, and the operator documentation overhaul. The new session is ready
for the user's actual request.

Plan: Await the substantive goal, then work iteratively and checkpoint
meaningful progress in this session.

## 2026-07-21 22:05 — External signer proposal drafted

Goal: Write a reviewable proposal for `sigstore-keyless`, `cosign-key`, and
`kms` signing support so private repositories without GitHub artifact
attestation access can still sign the action's evidence.

Current findings: The existing action already reserves all three signer names,
the key-reference input, the explicit no-fallback dispatch boundary, and the
three stable bundle roles. Current Cosign is v3.1.2. A local v3.1.1 probe proved
complete bundle creation and key verification, and also proved that relying on
Cosign defaults can create a permanent public Rekor entry even for a key-backed
run. The probe used only public repository files and a throwaway key; no user
secret was exposed. The local throwaway key directory was moved to Trash and is
recoverable there.

Proposal: `.journal/007/EXTERNAL_SIGNING_BACKENDS_PROPOSAL.md` specifies one
shared Cosign engine delivered in a disposable probe plus three vertical slices.
The initial privacy contract makes public Sigstore explicit for keyless and
uses a no-service signing configuration for key/KMS. Implementation has not
started; the next step is user review.
