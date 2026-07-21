# attest-vm-image

`attest-vm-image` is a GitHub Action that inspects a finished QCOW2 VM disk
image and produces auditable evidence about what is inside it, then optionally
signs that evidence.

Use it immediately after building an image so the exact bytes produced by the
builder are the bytes inspected and attested. The action never modifies the
input image.

## Start here

- Follow [Getting started](getting-started.md) to add unsigned validation to a
  workflow and inspect the resulting evidence.
- Use [Publish signed attestations](signing.md) when you are ready to sign and
  publish evidence with GitHub artifact attestations.
- Read [How it works](how-it-works.md) for the inspection and evidence model.

## Find an answer

- [Verify evidence and attestations](verification.md)
- [Control validation policy](validation-policy.md)
- [Troubleshoot a failed run](troubleshooting.md)
- [Action reference](reference.md)
- [Validation predicate](predicate/vm-image-validation-v1.md)
