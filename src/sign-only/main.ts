import * as fs from 'node:fs'
import * as path from 'node:path'
import * as core from '@actions/core'
import { parseSignOnlyInputs } from './inputs.js'
import { verifyEvidenceManifest } from './verify.js'
import { selectSigner } from '../sign/index.js'
import { EVIDENCE_MEDIA_TYPES, writeEvidenceManifest } from '../manifest.js'

/**
 * Orchestrate the sign-only companion action: parse inputs, re-verify the
 * evidence handoff fail-closed, sign it with the exact backend the main action
 * would use, and atomically promote the manifest to its signed form. The
 * signing backends themselves are unchanged — every privacy, self-verification,
 * and atomic-bundle-promotion property carries over — so this entrypoint only
 * adds the manifest re-verification boundary that lets signing run in a
 * separate job from image parsing. On any failure the manifest on disk is left
 * exactly as it was read.
 */
export async function run(): Promise<void> {
  try {
    const inputs = parseSignOnlyInputs()
    const handoff = await verifyEvidenceManifest(inputs.evidenceManifestPath, {
      diskPath: inputs.diskPath
    })

    // parseSignOnlyInputs rejected `none`, so a signer always comes back.
    const signer = selectSigner(inputs)
    if (!signer) {
      throw new Error('internal error: sign-only selected no signing backend.')
    }

    const { manifest } = handoff
    const signResult = await signer.sign({
      disk: {
        path: manifest.artifacts.disk.path,
        sha256: manifest.artifacts.disk.sha256
      },
      metadata: manifest.artifacts.metadata ?? undefined,
      sbom: handoff.sbom,
      statement: handoff.statement,
      outputDir: handoff.manifestDir
    })

    // Rewrite the manifest through a temp file + rename so a failure between
    // signing and promotion can never leave a half-written handoff. Evidence
    // paths are recorded in their locally-resolved form: after an artifact
    // round-trip those are the paths that exist in this job.
    const manifestPath = inputs.evidenceManifestPath
    const tmpPath = path.join(handoff.manifestDir, '.evidence-manifest.tmp')
    try {
      await writeEvidenceManifest({
        outputPath: tmpPath,
        result: manifest.result,
        artifacts: {
          disk: manifest.artifacts.disk,
          ...(manifest.artifacts.metadata
            ? { metadata: manifest.artifacts.metadata }
            : {}),
          ...(manifest.artifacts.buildManifest
            ? { buildManifest: manifest.artifacts.buildManifest }
            : {})
        },
        evidence: [
          ...handoff.evidence,
          ...signResult.bundles.map((bundle) => ({
            ...bundle,
            mediaType: EVIDENCE_MEDIA_TYPES.sigstoreBundle
          }))
        ],
        ...(signResult.attestationUrl
          ? { attestationUrl: signResult.attestationUrl }
          : {})
      })
      await fs.promises.rename(tmpPath, manifestPath)
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true })
      throw error
    }

    core.setOutput('attestation-bundle-path', signResult.bundleDir)
    if (signResult.attestationUrl) {
      core.setOutput('attestation-url', signResult.attestationUrl)
    }
    core.setOutput('evidence-manifest-path', manifestPath)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
    else core.setFailed(String(error))
  }
}
