# attest-vm-image

A GitHub Action that inspects a finished QCOW2 VM disk image and produces
auditable evidence about what is inside it, then optionally signs that evidence.

Run it immediately after an image build — ideally in the same job — so the exact
bytes the builder emitted are the bytes that get inspected and attested. The
action is independent of any one builder: it accepts a QCOW2 disk from
Distrobuilder, mkosi, Packer, bootc/Image Builder, or anything else.

The action **never modifies the input image**. It validates the disk structure,
inspects the filesystem read-only inside an isolated libguestfs appliance,
generates a Software Bill of Materials (SBOM), scans that SBOM for known
vulnerabilities, runs contamination checks for state that should not ship in a
reusable image, records everything in a versioned validation predicate, and
computes immutable digests. When explicitly asked, it signs and publishes
attestations.

The resulting evidence lets a later system or a human reviewer establish which
exact artifact was evaluated, what software it contained, which policy was
applied, what passed or failed, which workflow produced the evidence, and which
identity signed it.

## Usage

The default `signer: none` mode writes checksums, the SBOM, the vulnerability
and validation reports, the validation predicate, and a versioned evidence
manifest without signing, and needs only `contents: read`. Once an earlier step
in the job has built your image, add the action:

```yaml
jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      # An earlier step in this job builds your image at build/disk.qcow2.
      - uses: meigma/attest-vm-image@v1
        with:
          disk-path: build/disk.qcow2
          fail-on-severity: none
          signer: none
```

To sign and publish attestations, add three job permissions and set
`signer: github`:

```yaml
permissions:
  contents: read
  id-token: write
  attestations: write
steps:
  - uses: meigma/attest-vm-image@v1
    with: { disk-path: build/disk.qcow2, signer: github }
```

Signing has repository plan and visibility requirements, and a failing result is
never signed — see [Publish signed attestations][signing]. For a complete,
runnable workflow, start with the [Getting started][getting-started] tutorial.
Every input and output is listed in the [reference][reference].

## Requirements at a glance

- A Linux `x64` GitHub-hosted runner (`arm64` is best-effort); non-Linux
  platforms and other architectures fail closed.
- The action installs `qemu-utils` and `libguestfs-tools` itself at runtime, so
  the runner must permit `apt-get` and passwordless `sudo` — hosted `ubuntu-*`
  runners qualify by default.
- Outbound network access to `github.com` for the pinned `syft` and `grype`
  binaries, to the Grype vulnerability database, and — for `signer: github` — to
  the GitHub attestation API.

The full runner, privilege, and network catalog is in the
[reference][requirements].

## Documentation

- [Getting started][getting-started] — tutorial: wire the action into a
  workflow, produce a folder of evidence, and verify it yourself.
- [Publish signed attestations][signing] — how-to: switch to `signer: github`
  and publish signed GitHub attestations for the image.
- [Verify evidence and attestations][verification] — how-to: verify checksums
  and published attestations as a downstream consumer.
- [Control what fails validation][validation-policy] — how-to: tune the
  vulnerability threshold and the contamination policy.
- [Troubleshoot a failed run][troubleshooting] — how-to: a symptom-first
  decision path when a run fails.
- [Reference][reference] — every input, output, evidence file, requirement, and
  failure mode in one place.
- [How attest-vm-image works][how-it-works] — explanation: the mental model
  behind the evidence and the two ways a run can fail.

[getting-started]: https://meigma.github.io/attest-vm-image/getting-started/
[signing]: https://meigma.github.io/attest-vm-image/signing/
[verification]: https://meigma.github.io/attest-vm-image/verification/
[validation-policy]: https://meigma.github.io/attest-vm-image/validation-policy/
[troubleshooting]: https://meigma.github.io/attest-vm-image/troubleshooting/
[reference]: https://meigma.github.io/attest-vm-image/reference/
[requirements]: https://meigma.github.io/attest-vm-image/reference/#requirements
[how-it-works]: https://meigma.github.io/attest-vm-image/how-it-works/

## Development

Tooling is pinned by [mise](https://mise.jdx.dev) and tasks run through
[moon](https://moonrepo.dev).

```sh
mise install         # provision the pinned toolchain (Node, Python, uv, moon)
moon run root:check  # the full CI gate: format-check, lint, test, check-dist, audit
```

Useful project commands:

```sh
moon run root:format   # prettier --write
moon run root:lint     # eslint
moon run root:test     # jest
moon run root:package  # rebuild dist/
moon run docs:build    # build the documentation site strictly
moon run docs:serve    # serve the documentation site locally
```

The bundled action (`dist/index.js`) is **committed** — that is what
`action.yml` executes. After changing anything under `src/`, run
`moon run root:package` and commit the refreshed `dist/` in the same change;
CI's `check-dist` task rebuilds the bundle and fails if the committed copy is
stale.

The `audit` step runs `npm audit` at the strict `--audit-level=low` threshold
through `scripts/audit.mjs` (allowlist currently empty — any advisory fails the
gate). `package.json` carries an `overrides` block forcing `@sigstore/sign@^5`
and `@sigstore/bundle@^5` under `@actions/attest`, resolving the fixed
`@sigstore/core@^4.0.1` (GHSA-jfc7-64v2-mr8c); a unit test asserts the lockfile
resolves the patched majors so a silent regression fails in jest.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option. Upstream template code is MIT ([LICENSE.upstream](LICENSE.upstream)).
