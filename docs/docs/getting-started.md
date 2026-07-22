# Getting started

In this tutorial we wire `attest-vm-image` into a GitHub Actions workflow, run
it against a VM image, and read the folder of evidence it produces — a checksum
manifest, a Software Bill of Materials, a vulnerability report, and a validation
predicate that records a pass-or-fail verdict. We then confirm that evidence is
intact. By the end you will have a green workflow run and a folder of evidence
you produced and verified yourself.

We stop before signing. Publishing signed attestations is the very next guide,
[Publish signed attestations](signing.md).

## Before you start

You need a GitHub repository you can push to and whose Actions you can run. The
whole lesson runs on a GitHub-hosted `ubuntu-24.04` runner, so there is nothing
to install on your own machine — a web browser is enough.

We deliberately choose the two most forgiving settings so this first run's
vulnerability scan and signing step never fail the job: `signer: none` (write
evidence but do not sign it) and `fail-on-severity: none` (record
vulnerabilities but never fail on them). A run can also fail on a third,
independent axis — a failed contamination check — but the tiny image we build
below trips none of the built-in checks, so this run finishes green. On a real
image that policy still applies regardless of these two settings;
[Control what fails validation](validation-policy.md) covers it, and
[Publish signed attestations](signing.md) turns signing on.

The action's full runner, permission, and network requirements are cataloged in
[the reference](reference.md#requirements); at these settings the only job
permission you need is `contents: read`.

## The step at the heart of it

Everything below is scaffolding around a single step. In your own pipeline, once
an earlier step has built your image, you add this:

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

The action needs one thing from you: `disk-path`, pointing at a completed QCOW2
image the job has already produced. It writes its evidence under `./evidence` by
default.

To run the lesson identically for everyone, the workflow we build next stands a
tiny throwaway image in for "your build." In a real pipeline you would replace
that one build step with your actual image builder.

## Step 1: Add the workflow to your repository

We add two files. The first is a small script that builds the throwaway image;
you do not need to read or understand it. The second is the workflow itself.

Create `.github/scripts/make-image.sh`:

```bash
#!/usr/bin/env bash
# Builds a tiny, inspectable QCOW2 so this tutorial runs the same for everyone.
# It seeds a minimal Ubuntu-like ext4 root with an /etc/os-release and a small
# dpkg database. You do not need to read it; in a real pipeline your own builder
# produces the image instead.
set -euo pipefail

out="${1:?usage: make-image.sh <output-qcow2-path>}"

qemu-img create -f qcow2 "$out" 512M

# A 64-byte ELF header seeded as /sbin/init lets libguestfs resolve the guest
# architecture to x86_64 instead of "unknown".
init_elf="/tmp/attest-seed-init.elf"
printf '\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\002\000\076\000\001\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\100\000\000\000\000\000\000\000\000\000\000\000' >"$init_elf"

guestfish --rw -a "$out" <<'EOF'
run
mkfs ext4 /dev/sda
mount /dev/sda /
mkdir-p /etc
mkdir-p /bin
mkdir-p /sbin
mkdir-p /usr/bin
mkdir-p /var/lib/dpkg
mkdir-p /root
mkdir-p /home
mkdir-p /tmp
mkdir-p /run
write /etc/os-release "PRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"22.04\"\nVERSION=\"22.04.4 LTS (Jammy Jellyfish)\"\nVERSION_CODENAME=jammy\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=jammy\n"
write /etc/fstab "LABEL=cloudimg-rootfs / ext4 defaults 0 1\n"
upload /tmp/attest-seed-init.elf /sbin/init
write /var/lib/dpkg/status "Package: base-files\nStatus: install ok installed\nPriority: required\nSection: admin\nInstalled-Size: 393\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nArchitecture: amd64\nVersion: 12ubuntu4\nDescription: Debian base system miscellaneous files\n This package contains the basic filesystem hierarchy of a Debian system.\n\nPackage: openssl\nStatus: install ok installed\nPriority: optional\nSection: utils\nInstalled-Size: 1276\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nArchitecture: amd64\nVersion: 3.0.2-0ubuntu1\nDepends: libc6 (>= 2.34), libssl3 (>= 3.0.2)\nDescription: Secure Sockets Layer toolkit - cryptographic utility\n This package is part of the OpenSSL project's implementation of the SSL\n and TLS cryptographic protocols for secure communication over the Internet.\n\nPackage: zlib1g\nStatus: install ok installed\nPriority: required\nSection: libs\nInstalled-Size: 163\nMaintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nArchitecture: amd64\nMulti-Arch: same\nSource: zlib\nVersion: 1:1.2.11.dfsg-2ubuntu9\nDepends: libc6 (>= 2.14)\nDescription: compression library - runtime\n zlib is a library implementing the deflate compression method found in gzip\n and PKZIP.\n\n"
umount /
EOF

rm -f "$init_elf"
echo "Wrote seeded QCOW2 to $out"
```

Create `.github/workflows/attest.yml`:

```yaml
name: Attest VM image

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  attest:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: Check out the repository
        uses: actions/checkout@v7

      - name: Install libguestfs and qemu
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends qemu-utils libguestfs-tools
          sudo chmod +r /boot/vmlinuz-*

      - name: Build a throwaway image to attest
        env:
          LIBGUESTFS_BACKEND: direct
        run: bash .github/scripts/make-image.sh disk.qcow2

      - name: Attest the image
        id: attest
        uses: meigma/attest-vm-image@v1
        with:
          disk-path: disk.qcow2
          output-directory: ./evidence
          fail-on-severity: none
          signer: none

      - name: Show the evidence files
        run: ls -1 evidence

      - name: Show the downstream handoff
        env:
          EVIDENCE_MANIFEST: ${{ steps.attest.outputs.evidence-manifest-path }}
        run: jq . "$EVIDENCE_MANIFEST"

      - name: Verify the checksums
        run: sha256sum -c evidence/checksums.txt

      - name: Upload the evidence
        uses: actions/upload-artifact@v7
        with:
          name: evidence
          path: evidence
```

Notice the "Install libguestfs and qemu" step. Our job builds the image with
libguestfs _before_ the action runs, and a step that does that must install
those tools and make the host kernel readable itself — the action's own install
comes too late for an earlier step. This rule is spelled out in
[the reference](reference.md#requirements). Your real pipeline needs this step
only if it, too, uses libguestfs before the action.

Commit both files to your repository's default branch and push.

## Step 2: Run the workflow

Open the **Actions** tab, select **Attest VM image** in the left sidebar, and
click **Run workflow**. Watch the job start.

The "Attest the image" step takes about two minutes: it downloads and caches its
scanning tools before inspecting the image. Every dispatch of this workflow
starts on a fresh runner and re-downloads those tools, so expect roughly two
minutes each time you click **Run workflow**. Only a job that runs the action
more than once reuses the warm tool cache and finishes the later invocations in
about a minute.

Expected result: a green check on the run. Every step, including "Verify the
checksums", succeeds.

## Step 3: See what the action produced

Open the **Show the evidence files** step in the run log. You should see six
files:

```text
checksums.txt
evidence-manifest.json
sbom.spdx.json
validation-predicate.json
validation-report.json
vulnerability-report.json
```

Here is what each one is; the authoritative catalog lives in
[the reference](reference.md#evidence-files):

- `checksums.txt` — a `sha256sum -c`-style manifest listing the disk and every
  evidence file with its digest.
- `evidence-manifest.json` — the versioned handoff for a later verifier or
  publisher. It records the input disk and every evidence file by stable role,
  path, SHA-256, and media type.
- `sbom.spdx.json` — the Software Bill of Materials: every package the action
  found inside the image. Our seed image ships `base-files`, `openssl`, and
  `zlib1g`.
- `vulnerability-report.json` — known vulnerabilities in those packages. The
  seeded `openssl` is deliberately old, so this file has real findings — but
  because we set `fail-on-severity: none`, they do not fail the run.
- `validation-report.json` and `validation-predicate.json` — the verdict and its
  supporting detail. The difference between the two is described in
  [the reference](reference.md#evidence-files).

To hold the files yourself, scroll to the bottom of the run summary page, find
the **evidence** artifact, and download it. Unzip it and open
`validation-predicate.json` in any text editor. Search for `result` and you will
find:

```text
"result": "pass"
```

That single field is the action's overall verdict. It is `pass` because the
image tripped no contamination checks and we told the run not to fail on
vulnerabilities.

## Step 4: Confirm the evidence is intact

Open the **Verify the checksums** step in the run log. It ran
`sha256sum -c evidence/checksums.txt` and reported every file — the disk and
each evidence file — as `OK`:

```text
disk.qcow2: OK
evidence/sbom.spdx.json: OK
evidence/vulnerability-report.json: OK
evidence/validation-report.json: OK
evidence/validation-predicate.json: OK
```

`checksums.txt` records each path relative to the directory the action ran in,
so the check runs from that same directory — here, the workspace root, where
both `disk.qcow2` and `evidence/` live. The format and the full verification
procedure are in [the reference](reference.md#checksumstxt) and
[Verify evidence and attestations](verification.md).

You can rerun this integrity check any time to prove the evidence — and the
exact image bytes it describes — have not changed.

The evidence manifest is deliberately absent from `checksums.txt` because it is
written afterward and cannot hash itself. Instead it hashes `checksums.txt` and
each listed evidence file. Open the **Show the downstream handoff** step to see
the exact document a later pipeline step can consume through
`evidence-manifest-path`.

## What we did

You wired `attest-vm-image` into a workflow, ran it against a QCOW2 image, and
produced a complete folder of evidence: a checksum manifest, an SBOM, a
vulnerability report, and a validation predicate carrying a `pass` verdict. You
then verified that evidence against its own checksums. The action exposes the
versioned evidence manifest as the single downstream handoff, alongside the
individual file paths and disk digest in its step
[outputs](reference.md#outputs).

## Next steps

- [Sign attestations](signing.md) — publish through GitHub or create portable,
  offline bundles with an encrypted Cosign key.
- [Control what fails validation](validation-policy.md) — make the run actually
  fail on real vulnerabilities and on contamination you care about.
- [Verify evidence and attestations](verification.md) — verify what a producer
  published, as a downstream consumer.
- [Reference](reference.md) — every input, output, evidence file, and
  requirement in one place.
- [How attest-vm-image works](how-it-works.md) — the mental model behind the
  evidence and the two ways a run can fail.
