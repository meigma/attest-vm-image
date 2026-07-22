# Phase 0 external signing compatibility report

Status: complete; exit gate passed

Date: 2026-07-21

Production baseline: `main` at `2646b5c` (`v1.1.0`)

Disposable probe commit: `585a54ae1e6eab17716907785d78a27d4a694039`

## Decision

The proposed `cosign-key` foundation remains viable without changing the user
interface in the proposal. Phase 0 proved that Cosign v3.1.2 can sign the
action's three complete in-toto statements into Sigstore v0.3 bundles, verify
precomputed subjects and predicate types, and avoid Rekor entirely when given
an explicit no-service signing configuration.

The environment-only GitHub Actions SLSA provenance construction also matched
the current `@actions/attest` 3.2.0 OIDC-derived predicate exactly in the tested
ordinary same-repository push. Static-key and KMS modes therefore do not need
`id-token: write` merely to describe this workflow shape.

Proceed to Slice 1 only after explicit user approval. No production action code
was changed or proposed for merge by this probe.

## What ran

### Local encrypted-key probe

The local probe downloaded `cosign-darwin-arm64` v3.1.2 and verified its
SHA-256 against the release's `cosign_checksums.txt`:

```text
dec1c3f802320b19c2fbcf2dc7bcfb3f258e1c181a046c23a1a074bdf932f10a
```

It generated a random-password-protected throwaway key and signed synthetic,
complete statements for:

- SLSA provenance over `disk.qcow2` plus `incus.tar.xz`;
- SPDX 2.3 SBOM over `disk.qcow2`;
- VM-image validation over `disk.qcow2`.

The signing configuration explicitly removed default Fulcio, OIDC, Rekor, and
TSA services. Each resulting bundle reported:

```json
{
  "mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
  "tlogEntries": 0
}
```

### Hosted keyless probe

One trusted push workflow ran with only:

- `contents: read`;
- `id-token: write`.

Every external action was pinned to a full commit SHA. Dependency lifecycle
scripts and package-manager caching were disabled. The job used Cosign v3.1.2,
created one intentional public Sigstore entry over the synthetic provenance
statement, verified it by exact identity and issuer, and retained its public
outputs for one day.

- Run: [Phase 0 signing probe 29893836807](https://github.com/meigma/attest-vm-image/actions/runs/29893836807)
- Result: success in 21 seconds
- Artifact ID: `8519213621`, expires `2026-07-23T05:28:01Z`
- Rekor log index: `2216217956`
- Rekor UUID:
  `108e9186e8c5677a8808359942951071131d874370847c02834763cb8545e73a679318c4619c9567`
- Live entry: [Rekor API lookup](https://rekor.sigstore.dev/api/v1/log/entries?logIndex=2216217956)

## Exit-gate evidence

| Gate | Result |
| --- | --- |
| Exact Cosign v3.1.2 | Passed locally and hosted |
| Three complete in-toto statements | Passed with encrypted throwaway key |
| Sigstore v0.3 bundle media type | Passed for all local bundles and hosted keyless bundle |
| Decoded statement equals signed input | Passed for every bundle |
| Disk subject by precomputed SHA-256 | Passed for all three local claims and hosted keyless provenance |
| Metadata as second provenance subject | Passed by independently verifying the metadata digest against the provenance bundle |
| Predicate-type filtering | Expected types passed; a wrong type was rejected |
| Wrong subject digest | Rejected |
| Tampered signature | Rejected |
| Key-backed no-log mode | All three bundles had zero tlog entries with no Rekor service configured |
| Environment-built provenance | Exactly matched `@actions/attest`'s OIDC-derived predicate |
| Exact keyless identity and issuer | Passed; wrong identity and wrong issuer were rejected |
| Public entry durability | Live Rekor response matched the bundle's canonical body |

The exact keyless identity was:

```text
https://github.com/meigma/attest-vm-image/.github/workflows/phase0-signing-probe.yml@refs/heads/feat/phase-0-signing-probe
```

The exact OIDC issuer was:

```text
https://token.actions.githubusercontent.com
```

The environment-built SLSA predicate matched these OIDC-derived facts exactly:

- build type `https://actions.github.io/buildtypes/workflow/v1`;
- workflow repository, path, and full ref;
- event, repository ID, owner ID, and GitHub-hosted runner environment;
- source commit and Git dependency URI;
- builder identity;
- run ID and attempt invocation URL.

## What public keyless signing exposes

The live Rekor `dsse/0.0.1` body contains:

- the DSSE envelope SHA-256;
- the DSSE payload SHA-256;
- the signature;
- the complete Fulcio signing certificate.

The inspected Rekor body did **not** contain the full DSSE statement or
predicate. The local bundle and short-lived Actions artifact do contain that
statement, but the canonical public Rekor body carried its hashes only.

The certificate embedded in the permanent public entry disclosed:

- owner and repository name plus their numeric IDs;
- repository visibility;
- workflow name and path;
- full Git ref and source commit;
- event name;
- GitHub-hosted runner status;
- run ID, attempt, and run URL;
- the exact certificate identity and OIDC issuer.

This confirms the proposal's privacy split. Keyless is unsuitable when a
private repository's name, workflow path, branch/ref, commit, or run identity
must remain confidential. `cosign-key` and `kms` should retain the explicit
no-service default.

## Implementation consequences for Slice 1

1. Build the provenance predicate from the standard `GITHUB_*` and `RUNNER_*`
   environment without requesting OIDC.
2. Keep the exact `@actions/attest` 3.2.0 build type and predicate shape.
3. Supply Cosign a complete `--statement`; do not ask it to reconstruct
   subjects or hash the disk again.
4. Create and pass an explicit no-Fulcio/no-OIDC/no-Rekor/no-TSA signing
   configuration for `cosign-key`.
5. Verify all three bundles before promoting them into the evidence directory.
6. Document that `--insecure-ignore-tlog` disables the transparency witness,
   not public-key signature verification.
7. Preserve the independently trusted public-key requirement; the throwaway
   public key beside these probe bundles was verification material only.

## Limits deliberately left for later slices

- The local inputs were synthetic. Slice 1 must integrate the engine with the
  action's real existing validation predicate and evidence pipeline.
- The hosted probe signed only one keyless provenance statement to minimize
  permanent public records. Slice 2 must exercise all three keyless bundles.
- Exact environment/OIDC provenance equality was proved for an ordinary
  same-repository push, not a reusable workflow or GHES/GHE data-residency
  variant.
- No live KMS provider was contacted. That remains Slice 3 work selected around
  a real consumer.

## Cleanup and retained state

The throwaway private-key work directories were deleted at script exit. Local
download and public-result directories were moved to macOS Trash and are
recoverable there; they contain no private key. The hosted artifact contains
only public statements, bundle, certificate, and result data and expires after
one day.

The single Rekor entry is intentionally permanent and cannot be removed. After
this report was checkpointed, the disposable remote branch, local worktree, and
local branch were deleted. The successful Actions run retains the exact probe
commit and logs as evidence; no probe workflow remains on an active branch.
