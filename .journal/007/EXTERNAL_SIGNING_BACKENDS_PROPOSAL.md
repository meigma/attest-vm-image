# External signing backends proposal

Status: proposal for review; implementation has not started

Session: 007

Date: 2026-07-21
Baseline: `main` at `2646b5c` (`v1.1.0`)

## Outcome

Add working `sigstore-keyless`, `cosign-key`, and `kms` signers so a private
repository can produce the same three portable attestation bundles without
using GitHub's plan-gated attestation API.

Keep the existing conservative behavior:

- `signer: none` remains the default.
- `signer: github` remains unchanged.
- A requested backend is either used successfully or fails by name; there is no
  automatic fallback.
- A failing image is never signed.
- The validation predicate and the three existing attestation roles remain
  stable.

This should be delivered as a sequence of small, working vertical slices. The
first step is a disposable Cosign experiment, not a large refactor.

## Why the existing design is ready for this

The public interface already reserves all three signer names and the
`signing-key` input. The `Signer` boundary is also already in place. Current
code deliberately rejects the three external names instead of silently using a
different backend.

The contracts to preserve are:

- `attestations/provenance.sigstore.json` signs SLSA provenance. Its subjects
  are the disk and, when supplied, the metadata tarball.
- `attestations/sbom.sigstore.json` signs the emitted SBOM. Its only subject is
  the disk.
- `attestations/validation.sigstore.json` signs the existing versioned
  validation predicate. Its only subject is the disk.
- Bundles are emitted only for a passing result, in that stable order.
- Bundles are not added to `checksums.txt`; they are hashed into the later
  `evidence-manifest.json` handoff.

The main compatibility adjustment is small: `SignResult.attestationUrl` must
become optional. GitHub supplies a publication URL, while the three external
backends produce local bundles and intentionally leave `attestation-url` unset.

## Proposed user contract

| Signer | Signing identity | Required caller setup | Public transparency | Result |
| --- | --- | --- | --- | --- |
| `none` | none | `contents: read` | none | unsigned evidence |
| `github` | GitHub Actions OIDC | `id-token: write`, `attestations: write` | GitHub-managed | existing bundles plus URL |
| `sigstore-keyless` | GitHub Actions OIDC certificate | `id-token: write` | required public Sigstore services | three local bundles, no URL |
| `cosign-key` | caller-managed Cosign key pair | encrypted key reference and password environment | none initially | three local bundles, no URL |
| `kms` | non-exportable KMS or Transit key | provider auth in a preceding step and immutable KMS URI | none initially | three local bundles, no URL |

### Inputs

Keep the existing inputs rather than inventing provider-specific credentials:

- `signer` selects one backend explicitly.
- `signing-key` remains a locator, never key bytes or cloud credentials.
  - `cosign-key`: a readable encrypted key path or
    `env://COSIGN_PRIVATE_KEY`.
  - `kms`: an allowlisted Cosign KMS URI.
- `github-token` remains meaningful only to `signer: github`.

Reject contradictory or unsafe combinations early:

- `sigstore-keyless` with a `signing-key` value.
- `cosign-key` without a file or `env://NAME` reference.
- `kms` without an allowlisted URI.
- a `signing-key` value containing PEM headers, newlines, or other evidence that
  raw private-key bytes were placed in the input.

Do not add password, AWS, Google Cloud, Azure, Vault, or OpenBao credential
inputs. Secrets and short-lived provider credentials remain ordinary step
environment established by GitHub Secrets and the provider's authentication
action.

### Initial transparency behavior

Make privacy behavior deterministic without adding another input in the first
release:

- `sigstore-keyless` uses the public Sigstore Fulcio and Rekor services. This is
  intrinsic to its identity-based trust model. It must print a clear notice that
  the workflow identity and signing event are publicly auditable.
- `cosign-key` and `kms` use an explicit Cosign signing configuration with no
  Fulcio, Rekor, or TSA services. This avoids an unexpected public event for a
  private repository. Verification still proves the signature against an
  independently trusted public key, but has no public transparency witness.

Public Rekor logging for long-lived key/KMS modes can be a later opt-in if a
real consumer asks for it. It should not be slipped in through Cosign's defaults.

Keyless is therefore appropriate only when revealing the calling workflow's
identity to public Sigstore infrastructure is acceptable. A repository whose
name or workflow identity is confidential should use `cosign-key` or `kms`.

### KMS providers

Implement KMS through Cosign URI dispatch, not separate cloud SDKs. Initially
allow the built-in providers below:

| Provider | Required `signing-key` shape | Authentication before this action |
| --- | --- | --- |
| AWS KMS | `awskms:///arn:aws:kms:REGION:ACCOUNT:key/UUID` | GitHub OIDC through `aws-actions/configure-aws-credentials` |
| Google Cloud KMS | `gcpkms://projects/P/locations/L/keyRings/R/cryptoKeys/K/versions/N` | Workload Identity Federation through `google-github-actions/auth` |
| Azure Key Vault | `azurekms://VAULT.vault.azure.net/KEY/VERSION` | federated OIDC through `azure/login` |
| Vault Transit | `hashivault://KEY` | short-lived `VAULT_TOKEN` and `VAULT_ADDR` |
| OpenBao Transit | `openbao://KEY` | short-lived `BAO_TOKEN` and `BAO_ADDR` |

Require immutable AWS key IDs/ARNs and explicit Google Cloud/Azure key versions.
Do not accept AWS aliases for the initial contract. Vault/OpenBao URIs cannot
pin a version, so the signer must export the public key before and after the
three signatures and fail if its fingerprint changes.

`k8s://`, GitHub/GitLab-managed keys, hardware tokens, and external Cosign KMS
plugins are out of scope for the first version. They have different trust and
runtime assumptions and can be added only after a real use case appears.

## Implementation shape

Use one shared `CosignSigner` with three small configurations:

```text
src/sign/
  github.ts          # existing backend; behavior preserved
  cosign.ts          # shared statement signing and verification engine
  statements.ts      # shared subjects, predicate types, and in-toto statements
  types.ts           # optional URL and existing stable bundle roles
  index.ts           # explicit backend dispatch
```

The shared engine should:

1. Obtain a pinned Cosign binary only when one of the external signers is
   selected.
2. Assemble complete in-toto Statement v1 documents for provenance, SBOM, and
   validation from the already-computed `SignContext` digests.
3. Run `cosign attest-blob --statement ... --bundle ... --yes` for each
   statement. Supplying a complete statement preserves the metadata second
   subject and avoids re-hashing the QCOW2.
4. Self-verify every bundle with `cosign verify-blob-attestation --digest
   <existing-sha256> --digestAlg sha256`, the expected predicate type, and the
   exact expected identity or public key.
5. Write into a temporary bundle directory and rename it into
   `attestations/` only after all three bundles verify.
6. Return the existing three bundle roles in stable order and no URL.

The remote operation cannot be atomic. A keyless failure on the second or third
attestation can leave an earlier permanent transparency entry. Local temporary
staging prevents partial bundles from being presented as a successful handoff,
but the documentation must be honest that public log entries cannot be rolled
back.

### Provenance construction

Prototype this before changing production code. The current GitHub backend asks
`@actions/attest` to construct a GitHub Actions SLSA v1 predicate. External
key-backed modes must not require `id-token: write` merely to describe the
workflow.

The preferred result is a shared, deterministic SLSA v1 statement assembled
from the standard immutable `GITHUB_*` and `RUNNER_*` environment fields. The
prototype must compare it with a decoded current GitHub bundle and prove:

- predicate type remains `https://slsa.dev/provenance/v1`;
- builder, workflow, ref, source commit, run ID, and attempt are present;
- the disk is always a subject;
- metadata is a second subject only when supplied.

Do not reshape the existing validation predicate to solve provenance.

### Cosign acquisition

Use current Cosign `v3.1.2` as the implementation baseline, then recheck the
latest security release when work starts. Version 3.1.2 was current on
2026-07-21 and its release notes warn that v4 will remove deprecated behavior.

For the throwaway prototype, a workflow may install the exact version through a
full-SHA-pinned `sigstore/cosign-installer` step. The production action should
remain self-contained: extend `src/tools.ts` to download the Linux x64/arm64
Cosign release binary, verify an exact per-platform SHA-256, mark it executable,
and cache it. `none` and `github` must not pay this download or network cost.

Never use `latest`, an unverified download, or an ambient runner Cosign binary.

### Secret-safe execution

The existing command wrapper prints its full argument list as a workflow-log
group name. Add a caller-supplied redacted display label before passing any key
reference to Cosign.

- Private key bytes and passwords stay in environment variables.
- `COSIGN_PASSWORD` is never accepted as an action input or command argument.
- Resolve `env://NAME` only to confirm the variable exists and mark its value as
  a secret; never log the value.
- Redact local key paths and KMS URIs from group labels and error wrappers.
- Pass arguments as an array through `@actions/exec`; never interpolate a shell
  command.
- For keyless, explicitly select the `github-actions` OIDC provider and preflight
  the Actions OIDC request environment so Cosign cannot fall into an interactive
  browser flow.

## Delivery plan

Each slice ends in something demonstrably usable. Later slices may revise the
proposal based on what the earlier one teaches us.

### Phase 0 — disposable compatibility probe

Timebox one short session. Do not merge production code.

- Pin the probe to Cosign v3.1.2.
- Sign three complete in-toto statements with a throwaway encrypted key.
- Prove bundle media type, subject checking by precomputed digest, predicate type
  filtering, metadata as the second provenance subject, and tamper failure.
- Prove an explicit empty signing configuration creates no Rekor entry.
- Capture the exact keyless GitHub certificate identity and issuer in a hosted
  same-repository run.
- Inspect what the public log makes durable for a private workflow; record facts
  instead of assuming older Cosign behavior.

Exit gate: the three statements verify with the intended Cosign commands and no
unexpected publication occurs in the key-backed no-log mode. If this fails,
revise the interface before touching the action.

### Slice 1 — `cosign-key` plus the shared foundation

One focused PR:

- add the pinned Cosign acquisition path;
- add redacted command labels and signer-specific input validation;
- make `attestationUrl` optional without changing GitHub behavior;
- add the external statement builder and shared Cosign engine;
- implement encrypted file and `env://NAME` key references;
- create a no-service signing configuration explicitly;
- self-verify and atomically promote the three bundles;
- replace the `cosign-key` "not implemented" test with real dispatch tests;
- add an unprivileged integration test using a generated throwaway key;
- document signing and verification with an independently trusted `cosign.pub`.

Exit gate: on every PR, a real encrypted key signs all three statements, all
three verify against the trusted public key, a changed disk/bundle fails, no
public transparency entry is created, and `none`/`github` regression tests pass.

### Slice 2 — `sigstore-keyless`

One focused PR built on Slice 1:

- select the shared Cosign engine with no key reference;
- require and preflight `id-token: write` without requesting any GitHub API write
  scope;
- force the GitHub Actions OIDC provider and noninteractive operation;
- log a prominent public-transparency notice before signing;
- self-verify using the exact workflow certificate identity and
  `https://token.actions.githubusercontent.com` issuer;
- add exact-identity verification documentation, never permissive `.*` examples;
- add a deliberately bounded hosted smoke on a trusted same-repository event.

Exit gate: the hosted run produces and verifies all three bundles, and a missing
OIDC permission fails immediately with a named diagnostic rather than hanging
or prompting.

### Slice 3 — `kms`

One focused PR built on Slice 1:

- allowlist and parse the five URI schemes above;
- rely only on ambient provider credentials created by a preceding workflow
  step;
- extract a temporary public key for self-verification;
- use the no-service signing configuration by default;
- enforce immutable identifiers where the URI supports them;
- perform the Vault/OpenBao before/after fingerprint guard;
- replace the `kms` "not implemented" test with provider dispatch tests;
- field-test one real provider selected by the first consumer.

Absent an immediate consumer choice, use AWS KMS as the first hosted canary
because its asymmetric signing permissions and GitHub OIDC path are direct and
well documented. Label the other providers "supported by URI contract" until
each has been exercised; do not imply all were field-tested.

Exit gate: a real non-exportable key signs and verifies all three statements
with least-privilege credentials, and a bad URI, missing auth, wrong key type,
or rotated key fails without fallback.

### Slice 4 — release hardening

Fold documentation into each slice, then do one final cross-backend pass:

- update `action.yml`, README, signing, verification, reference,
  troubleshooting, and network/permissions tables;
- test all output set/unset conditions and evidence-manifest bundle ordering;
- test a validation failure produces unsigned evidence and invokes no signer;
- test an external signing failure leaves no handoff manifest or outputs;
- rebuild and commit `dist/` after every `src/` change;
- run `moon run root:check` before each PR is proposed;
- run one manual consumer workflow from a private repository before release.

Release only when the private-repository consumer can independently verify the
validation bundle from the downloaded evidence.

## Verification contract

External bundles are verified with Cosign, not `gh attestation verify`.

Keyless validation example:

```sh
cosign verify-blob-attestation \
  --bundle evidence/attestations/validation.sigstore.json \
  --certificate-identity \
    "https://github.com/OWNER/REPO/.github/workflows/WORKFLOW.yml@REF" \
  --certificate-oidc-issuer \
    "https://token.actions.githubusercontent.com" \
  --type \
    "https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1" \
  disk.qcow2
```

Key/KMS no-log validation example:

```sh
cosign verify-blob-attestation \
  --bundle evidence/attestations/validation.sigstore.json \
  --key independently-trusted-cosign.pub \
  --insecure-ignore-tlog \
  --type \
    "https://meigma.github.io/attest-vm-image/predicate/vm-image-validation/v1" \
  disk.qcow2
```

The `--insecure-ignore-tlog` name means "do not require a transparency witness";
it does not disable verification against the supplied public key. Documentation
must still explain the lost timestamp/audit property plainly.

Do not package a newly exported public key and then present it as trusted merely
because it travelled beside its signature. The consumer must pin the expected
public key or fingerprint through an independent trust channel. The signer may
use an exported temporary key internally for self-verification.

## Test matrix

| Layer | Required proof |
| --- | --- |
| Unit | input combinations, URI allowlist, no fallback, redacted labels, exact statements, optional URL, stable bundle ordering |
| Local integration | real Cosign, encrypted throwaway key, three bundles, no-log config, self-verification, tamper failure |
| Hosted keyless | GitHub OIDC, exact certificate identity/issuer, three public-log bundles, missing-permission failure |
| Hosted KMS | one real non-exportable key, least-privilege auth, public-key extraction, rotation/fingerprint checks |
| Existing CI | `signer: none`, `signer: github`, evidence-complete failure, committed `dist/`, `moon run root:check` |

Tests must assert the decoded DSSE statement, not just that a JSON file exists.
Mocks remain useful for error paths, but each backend needs at least one real
Cosign verification path.

## Explicit non-goals

- Automatically choosing a signer based on repository visibility or plan.
- Falling back from GitHub to public keyless signing.
- Generating, rotating, importing, or deleting production keys.
- Accepting raw private keys, passphrases, or cloud credentials as action inputs.
- Provisioning cloud IAM, OIDC trust, Vault policies, or KMS resources.
- Supporting a private Sigstore deployment or arbitrary Fulcio/Rekor URLs.
- Publishing bundles to an OCI registry or another remote store.
- Signing a failing validation result.
- Redesigning the validation predicate or the existing GitHub signer.
- Adding hardware-token, Kubernetes Secret, GitHub key, GitLab key, or plugin
  KMS schemes before a concrete consumer asks for them.

## Decisions deliberately deferred

- Public Rekor opt-in for `cosign-key` and `kms`.
- A new evidence-manifest schema carrying descriptive signer metadata.
- Emitting a convenience public-key file or fingerprint output. If added later,
  it must be labelled verification material, not a trust anchor.
- Continuous live tests for every cloud provider. Start with the provider a real
  consumer needs, then add coverage as support is exercised.

These deferrals keep the first useful backend small and leave room to learn from
real private-repository use.

## Approval boundary

Approval of this document should authorize only Phase 0 and Slice 1. Review the
working `cosign-key` result and the captured keyless/KMS facts before starting
Slices 2 and 3. That preserves the ability to change the interface cheaply when
the prototype teaches us something unexpected.

## Primary references

- [Cosign v3.1.2 release](https://github.com/sigstore/cosign/releases/tag/v3.1.2)
- [Cosign `attest-blob`](https://github.com/sigstore/cosign/blob/v3.1.2/doc/cosign_attest-blob.md)
- [Cosign `verify-blob-attestation`](https://github.com/sigstore/cosign/blob/v3.1.2/doc/cosign_verify-blob-attestation.md)
- [Sigstore key management and KMS URI formats](https://docs.sigstore.dev/cosign/key_management/overview/)
- [Sigstore self-managed keys](https://docs.sigstore.dev/cosign/key_management/signing_with_self-managed_keys/)
- [Sigstore bundle format](https://docs.sigstore.dev/about/bundle/)
- [Sigstore security model](https://docs.sigstore.dev/about/security/)
- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
