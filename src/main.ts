import * as fs from 'node:fs'
import * as path from 'node:path'
import * as core from '@actions/core'
import { parseInputs } from './inputs.js'
import { loadPolicy, runContamination } from './contamination.js'
import { ensureAptPackages, ensureBinary, toolVersions } from './tools.js'
import { sha256File } from './hash.js'
import { validateDisk } from './disk.js'
import { inspectFilesystem } from './inspect.js'
import { validateMetadata } from './metadata.js'
import { generateSbom } from './sbom.js'
import { scanVulnerabilities } from './vuln.js'
import { workflowContext } from './context.js'
import { writeEvidence } from './predicate.js'
import type { PredicateState } from './predicate.js'
import { writeChecksums } from './checksums.js'
import { CleanupRegistry } from './cleanup.js'
import { selectSigner } from './sign/index.js'
import type { SbomFormat } from './inputs.js'

/**
 * Fixed evidence basenames written under `output-directory`. The SBOM basename
 * depends on the selected format; every other name is constant.
 */
export const OUTPUT_FILES = {
  checksums: 'checksums.txt',
  sbomSpdx: 'sbom.spdx.json',
  sbomCyclonedx: 'sbom.cyclonedx.json',
  vulnerabilityReport: 'vulnerability-report.json',
  validationReport: 'validation-report.json',
  validationPredicate: 'validation-predicate.json'
} as const

// The SBOM basename for a given format.
function sbomBasename(format: SbomFormat): string {
  return format === 'cyclonedx-json'
    ? OUTPUT_FILES.sbomCyclonedx
    : OUTPUT_FILES.sbomSpdx
}

/**
 * Orchestrate the full `signer: none` evidence pipeline: parse inputs, run every
 * stage in the fixed order against a shared `state` object, write all evidence,
 * seal checksums, and set outputs. A `CleanupRegistry` is drained in `finally`
 * so mounts, handles, and temp dirs are removed on both success and failure. Any
 * thrown stage fails the run via `core.setFailed`; a completed run whose overall
 * `result` is `fail` (a threshold breach or a failed contamination check) still
 * writes complete evidence and then fails with a distinct, evidence-complete
 * message.
 */
export async function run(): Promise<void> {
  const registry = new CleanupRegistry()
  try {
    // Stage 1: parse inputs and resolve the contamination policy.
    const inputs = parseInputs()
    const policyResult = await loadPolicy(inputs.policyPath)

    // Resolve evidence paths under the output directory (created up front).
    const outDir = inputs.outputDirectory
    await fs.promises.mkdir(outDir, { recursive: true })
    const sbomPath = path.join(outDir, sbomBasename(inputs.sbomFormat))
    const vulnPath = path.join(outDir, OUTPUT_FILES.vulnerabilityReport)
    const reportPath = path.join(outDir, OUTPUT_FILES.validationReport)
    const predicatePath = path.join(outDir, OUTPUT_FILES.validationPredicate)
    const checksumsPath = path.join(outDir, OUTPUT_FILES.checksums)

    // Build-manifest digest, computed right after stage 1 when provided.
    const buildManifest = inputs.buildManifestPath
      ? { sha256: await sha256File(inputs.buildManifestPath) }
      : undefined

    // Acquire external tools before any stage that shells out to them.
    await ensureAptPackages()
    await ensureBinary('syft')
    await ensureBinary('grype')

    // Stage 2: validate the QCOW2 disk.
    const disk = await validateDisk(inputs.diskPath)

    // Stage 3: inspect the filesystem read-only (registers its own cleanup).
    const fsView = await inspectFilesystem(inputs.diskPath, registry)

    // Stage 4: validate Incus metadata when provided.
    const metadata = inputs.metadataPath
      ? await validateMetadata(inputs.metadataPath, registry)
      : undefined

    // Stage 5: generate the SBOM.
    const sbom = await generateSbom(
      fsView,
      inputs.sbomFormat,
      disk.sha256,
      sbomPath
    )

    // Stage 6: scan for vulnerabilities (a threshold breach does not throw).
    const vuln = await scanVulnerabilities(
      sbom.path,
      inputs.failOnSeverity,
      vulnPath
    )

    // Stage 7: run contamination checks.
    const contamination = runContamination(fsView, policyResult)

    // Resolve tool versions after apt install so dpkg-query reports real ones.
    const tools = await toolVersions()

    // Stage 8: assemble and write the predicate and report.
    const state: PredicateState = {
      diskPath: inputs.diskPath,
      disk,
      metadata,
      buildManifest,
      tools,
      fsView,
      sbom,
      vuln,
      contamination,
      threshold: inputs.failOnSeverity,
      workflow: workflowContext()
    }
    const statement = await writeEvidence(state, { predicatePath, reportPath })
    const result = statement.predicate.result

    // Stage 9: seal checksums (re-digests the disk; throws if it changed).
    await writeChecksums({
      diskPath: inputs.diskPath,
      expectedDiskSha256: disk.sha256,
      extraInputs: [
        ...(inputs.metadataPath ? [inputs.metadataPath] : []),
        ...(inputs.buildManifestPath ? [inputs.buildManifestPath] : [])
      ],
      evidenceFiles: [sbom.path, vuln.path, reportPath, predicatePath],
      outputPath: checksumsPath
    })

    // Stage 10: sign — only when a signer is selected and the result passed.
    // A failing result is never signed (design): the unsigned evidence is
    // written in full, signing is skipped with a notice, and the action then
    // fails on the evidence-complete result below.
    if (inputs.signer === 'none') {
      core.info('signer is "none"; skipping attestation (unsigned evidence).')
    } else if (result === 'pass') {
      // selectSigner never falls back: it returns the requested backend or
      // throws a named diagnostic (a fail-closed abort inside this try).
      const signer = selectSigner(inputs)
      if (signer) {
        const signResult = await signer.sign({
          disk: { path: inputs.diskPath, sha256: disk.sha256 },
          metadata:
            metadata && inputs.metadataPath
              ? { path: inputs.metadataPath, sha256: metadata.sha256 }
              : undefined,
          sbom: { path: sbom.path, format: sbom.format, sha256: sbom.sha256 },
          statement,
          outputDir: outDir
        })
        core.setOutput('attestation-bundle-path', signResult.bundleDir)
        core.setOutput('attestation-url', signResult.attestationUrl)
      }
    } else {
      core.info(
        `signer "${inputs.signer}" was selected, but the validation result is ` +
          '"fail"; a failing result is never signed. Complete unsigned ' +
          'evidence was written and no attestation was issued.'
      )
    }

    // Set every non-signing output. Attestation outputs are set only when a
    // signer runs (a passing result with a non-"none" signer).
    core.setOutput('disk-digest', `sha256:${disk.sha256}`)
    core.setOutput('checksums-path', checksumsPath)
    core.setOutput('sbom-path', sbom.path)
    core.setOutput('vulnerability-report-path', vuln.path)
    core.setOutput('validation-report-path', reportPath)
    core.setOutput('validation-predicate-path', predicatePath)

    // Evidence-complete failure: the pipeline finished and wrote full evidence,
    // but the image did not pass. This is distinct from the fail-closed aborts
    // above, which throw before any evidence exists.
    if (result === 'fail') {
      const failedChecks = contamination.checks.filter(
        (check) => check.status === 'fail'
      )
      const reasons: string[] = []
      if (vuln.thresholdExceeded) {
        reasons.push(
          `vulnerability findings at or above the "${inputs.failOnSeverity}" ` +
            'threshold'
        )
      }
      if (failedChecks.length > 0) {
        reasons.push(
          `${failedChecks.length} contamination check(s) failed ` +
            `(${failedChecks.map((check) => check.id).join(', ')})`
        )
      }
      core.setFailed(
        `Validation result is "fail"; complete evidence was written to ` +
          `"${outDir}". Reason: ${reasons.join('; ')}.`
      )
    }
  } catch (error) {
    // Fail-closed abort: a stage threw before evidence was completed.
    if (error instanceof Error) core.setFailed(error.message)
    else core.setFailed(String(error))
  } finally {
    await registry.drain()
  }
}
