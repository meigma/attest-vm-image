# How attest-vm-image works

This page explains the ideas behind the action: why it behaves the way it does,
and what that behavior means for the automation you build on top of it. It
complements the [reference](reference.md), which says exactly _what_ every
input, output, and file is, and the how-to guides, which walk through _doing_
specific tasks. If you are building a promotion gate, an audit trail, or an
alerting rule on top of the evidence, the reasoning here is what keeps that
automation correct when a run behaves in a way that, at first glance, looks like
a bug.

The action does one narrow thing: it reads a finished QCOW2 disk image and
records, in a verifiable form, what it found. It does not build the image, boot
it, remediate it, import it, or decide on your behalf how the evidence should be
trusted. Almost everything below follows from that single-purpose, read-only,
fail-closed stance.

## Where it fits in a build pipeline

The action is meant to run in the same job as your image build, immediately
after the build step. That recommendation is not arbitrary. The evidence is only
as meaningful as the guarantee that the bytes it describes are the bytes your
builder actually produced. Every artifact the action emits is anchored to a
single digest of the disk file, so the whole value of a run rests on the chain
of custody between "the builder wrote this file" and "the action read this
file."

The shorter that chain, the stronger the claim. If you attest in a separate job,
the image first travels through an artifact store — uploaded, stored, downloaded
again — and the thing you attest is a copy whose history now includes that round
trip. Running in the same job keeps the file the builder wrote and the file the
action reads one and the same. It also makes the action's non-mutation guarantee
(below) directly meaningful, because there is no opportunity for an intervening
step to alter the image between build and attestation.

The action takes no opinion about which builder produced the disk.
Distrobuilder, mkosi, Packer, bootc/Image Builder, or a hand-rolled `qemu-img`
pipeline all work identically, because the action's only contract is the
finished disk in QCOW2 form. It is deliberately a small, composable step you
drop in after whatever you already use, not a build system that wants to own
your pipeline.

## One read, in a fixed order

A run is a single pass over the image in a fixed order: it acquires its tools,
validates the disk structure, inspects the filesystem, validates the optional
Incus metadata archive, generates an SBOM, scans that SBOM for vulnerabilities,
runs the contamination checks, writes the evidence documents, seals the
checksums, and — only then, and only if asked — signs. It finishes by writing a
versioned evidence manifest that hands all completed outputs to a downstream
consumer. Each step's output feeds the next, which is why the order is fixed
rather than configurable.

The one part of that order that surprises people is the first part: the action
installs and verifies all of its tools _before_ it even checks that `disk-path`
points at a real file. This is not an oversight. Validating the disk leans on
those tools — confirming the file is a valid QCOW2 is a `qemu-img` job, and
`qemu-img` is one of the tools the action provisions — so there is little to
check until they are in place. Rather than scatter "install the thing I need for
this step" throughout the run, the action acquires everything up front, once.

The practical consequence is worth internalizing: a mistyped `disk-path` does
not fail in a fraction of a second. The `apt` install and the `syft`/`grype`
downloads run first, and only afterward does the disk check report the bad path.
On a warm runner the tools are already cached and the abort is quick; on a cold
runner you pay the download cost before seeing the error. That is expected — the
[requirements](reference.md#requirements) and
[tool versions](reference.md#tool-versions) sections describe exactly what gets
fetched.

## Fail-closed, and why there are two kinds of failure

The action is fail-closed: when it cannot complete a step cleanly, it stops
rather than guessing or emitting partial, optimistic evidence. A missing verdict
is safer than a false one — silence never gets mistaken for a pass. This is the
single most important idea for reasoning about the action's behavior under
stress.

But "failure" can mean two genuinely different things, and the action keeps them
apart on purpose. The [reference](reference.md#failure-modes) catalogs the exact
messages; here is why the distinction exists at all.

The first kind is an **abort before evidence**. Something made the run
impossible to complete honestly: the input is not a QCOW2, the metadata archive
contains an unsafe entry, a downloaded tool did not match its pinned digest. The
action throws, sets no outputs, and no complete evidence exists to consume. This
is the "I could not evaluate this" outcome.

The second kind is an **evidence-complete failure**. The action evaluated the
image without trouble, and the image itself did not pass — vulnerabilities at or
above your configured threshold, or a contamination check that tripped. Here the
whole pipeline runs, every evidence file is written (the predicate records a
`fail` result), all seven standard outputs are set, and only then does the run
fail. This is the "I evaluated this and it failed" outcome.

These call for opposite responses, which is why conflating them causes bugs. An
evidence-complete failure is a _finding_, not a transient error to retry — the
image really is unfit to ship, and the evidence explaining why is sitting in the
output directory ready to upload or inspect. An abort, by contrast, often points
at a fixable mistake in the workflow rather than a defect in the image. Most
aborts fire early — a bad `disk-path`, a non-QCOW2 image, unsafe metadata, a
tool that failed its integrity check — before any evidence is written, so the
usual outcome is nothing to upload. But an abort in a later stage can leave a
partial subset behind: a vulnerability-scan error, for instance, throws only
after the SBOM has already been written to disk. So a step that archives the
evidence directory on failure gets the complete set only in the
evidence-complete case, and should be ready to find nothing — or a stray partial
file — after an abort.

One corollary catches people out: a thrown error _anywhere_ sets none of the
outputs. Signing happens after the unsigned evidence is sealed but before the
handoff manifest is written. A signing failure therefore leaves the pre-manifest
unsigned evidence on disk but reports no outputs and creates no handoff. "The
step failed" tells you nothing on its own about whether evidence exists; the
taxonomy above does. The [troubleshooting guide](troubleshooting.md) turns this
into a concrete decision path.

## Why it never touches the image

The action promises never to modify the disk you hand it, and it backs that
promise three ways rather than merely asserting it.

First, the inspection is genuinely read-only. The disk is opened read-only, and
the guest filesystem is served over FUSE from an isolated `libguestfs`
appliance. Nothing mounts the image into the runner's own kernel.

Second, no code from inside the image ever runs. The untrusted filesystem is
parsed by the appliance's own kernel, not the host's, and the action never boots
or executes anything it finds in the guest. You are potentially handing the
action a hostile disk; it treats that disk as inert data to be read, never as a
system to be started. This is why the isolation matters and why the action needs
the host kernel to be readable at all (see
[requirements](reference.md#requirements)).

Third, the guarantee is checked, not just intended. Before the action seals the
[checksums](reference.md#checksumstxt), it re-hashes the disk and compares the
result to the digest it computed at the very start. If a single byte differs, it
refuses to finish. This turns "we do not modify the image" into an invariant the
run enforces on itself: a concurrent step that scribbles on the file, or any
accidental write, is caught and fails the run rather than being quietly
attested.

## The evidence it leaves behind

Every completed run — signed or not — produces the same core set of evidence: an
immutable checksum manifest, an SBOM, a vulnerability report, two closely
related JSON documents (the validation predicate and validation report), and a
versioned evidence manifest. The [reference](reference.md#evidence-files)
enumerates the exact files; the point worth understanding is how those documents
relate.

The predicate and the report are two views of the same result. The predicate is
the compact, signable claim — the payload an attestation carries. The report is
the same content plus one addition: the raw Incus metadata `properties`. That
split is deliberate. The `properties` block is free-form, builder-supplied, and
potentially large, whereas the predicate is meant to be a stable, minimal,
machine-checkable claim. So the predicate carries only a _digest_ of the
metadata, while the report keeps the full `properties` for a human or a
debugging tool that wants to see them. The signed thing stays lean and stable;
the readable thing stays complete. Field-by-field definitions live in the
[predicate reference](predicate/vm-image-validation-v1.md).

The checksum manifest is the baseline everyone can rely on. Even with no signing
at all, anyone holding the evidence directory can confirm the files are the ones
the action wrote and that the recorded disk digest is the digest they have. It
is the floor of verifiability that does not depend on any signing
infrastructure; the [verification guide](verification.md) shows how to use it.

The evidence manifest serves a different purpose: it is the machine-readable
handoff for the next pipeline stage. It identifies the exact input artifacts and
lists every produced evidence file by stable role, path, media type, and digest.
That lets a later verifier or publisher consume one versioned document instead
of reconstructing this action's directory layout or combining several outputs.
The action constructs the list from its known pipeline state; it never discovers
arbitrary files by scanning the output directory.

When you do sign, the attestations are also written locally as Sigstore bundles
alongside the evidence. Those bundles are deliberately excluded from the
checksum manifest: they are produced _after_ the checksums are sealed and carry
their own Sigstore verification material, so folding them back into a manifest
they postdate would be both impossible and redundant. They do appear in the
later-written evidence manifest after signing succeeds. The
[attestation bundles](reference.md#attestation-bundles) reference describes what
each one covers.

## Why a failing image is never signed

A failing result is never signed, whatever signer you selected. If the image
does not pass, the action writes its full unsigned evidence and then stops
without attesting anything.

This is a values decision, not a limitation. An attestation is a positive claim
carrying a trusted identity's signature. A signature over "this image failed
validation" would be worse than no signature at all: it is a credential that
downstream tooling — glancing only at whether _an_ attestation exists — could
mistake for approval. By only ever signing a passing result, the action keeps
the meaning of an attestation unambiguous. If the attestation exists, the image
passed. Full stop. The unsigned evidence is still written so you can audit
exactly _why_ a run failed, but nothing carries the action's signature unless
the verdict was `pass`.

This is why "I set `signer: github` but nothing was signed" is expected
behavior, not a defect, on any run whose result was `fail`. See the
[signing guide](signing.md) for the producer side and the
[troubleshooting guide](troubleshooting.md) for spotting it in a log.

The same principle explains why there is no signer fallback. When the requested
signer cannot authenticate, reach its service, or use its configured key, the
action fails with a named cause and never quietly signs with something else or
drops to unsigned output. The choice of signer is a trust decision that only the
caller can legitimately make. Silently downgrading it would hand you an artifact
signed by a method or identity you did not choose, or leave you believing
something was signed when it was not. A hard failure is the honest outcome; the
[permissions](reference.md#permissions) reference lays out exactly what
`signer: github` requires.

## How it trusts its own tools

A consumer's runner is not the action's development environment. The action
cannot assume that `qemu`, `libguestfs`, `syft`, `grype`, or an optionally
needed `cosign` are already present, so it installs them itself on every run —
which is also why it needs `apt` and `sudo` on the runner (see
[requirements](reference.md#requirements)). More interesting than _that_ it
acquires tools is _how it decides to trust_ what it downloads, because it uses
two different trust models for two classes of tool.

`syft`, `grype`, and (only when external signing needs it) `cosign` arrive as
**pinned, digest-verified binaries**. Each is downloaded from GitHub Releases at
an exact version, and the bytes are checked against a SHA-256 digest baked into
the action for that precise version and platform. A mismatch aborts the run
before the tool is ever extracted or executed. The pin is the trust anchor: it
changes only through a reviewed change to the action itself, so a compromised or
swapped release asset cannot slip in unnoticed between runs. The exact pinned
versions are in the [tool versions](reference.md#tool-versions) reference.

`qemu-utils` and `libguestfs-tools` arrive as **unpinned `apt` packages** from
Ubuntu's signed archive. They carry no version pin — not because they matter
less, but because the archive only ever offers its current build; there is no
older, byte-for-byte version left to pin to. Trust here rests on `apt`'s own
signature verification against the distribution, and the action records the
exact versions it actually received (read back via `dpkg`) into the evidence.
The input was not pinned in advance, but the record of what ran is precise after
the fact.

## Why arm64 is best-effort

`libguestfs` inspects a disk by booting a small, throwaway appliance virtual
machine and reading the guest through it. On an x64 runner that appliance runs
with KVM hardware acceleration, so inspection is fast. GitHub-hosted arm64
runners do not expose KVM, so QEMU falls back to TCG — pure software CPU
emulation. The inspection still works and reads the same guest data either way,
so a run produces the same findings — the same packages, the same
vulnerabilities, the same contamination results. It is simply much slower.

That performance cliff, not any correctness gap, is the whole reason x64 is the
supported and tested target while arm64 is labeled best-effort. There is nothing
wrong with attesting on arm64 — you should just expect longer runs and set your
job timeouts accordingly. The [requirements](reference.md#requirements)
reference states the supported platforms plainly.

## A versioned, opaque predicate type

The validation predicate is identified by a versioned URI that looks like a web
address but is not one: nothing is served at it, and the action stands up no
site to serve it. In-toto predicate types are _identifiers_, not endpoints. The
URI's only job is to name a schema unambiguously, and the schema itself lives in
the repository (see the
[predicate reference](predicate/vm-image-validation-v1.md)).

Two things follow for anyone building on the predicate. First, do not write
automation that fetches the predicate type expecting a document back — read the
schema from the repository instead. Second, versioning is additive: a breaking
change to the predicate's shape mints a new `v2` URI paired with a new schema
and leaves `v1` in place. Consumers that key off the `v1` identifier keep
working untouched and opt into `v2` only when they are ready. That is precisely
why the version lives inside the identifier rather than in a field you have to
parse and branch on — the identifier _is_ the compatibility contract.
