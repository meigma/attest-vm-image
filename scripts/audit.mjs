// Scoped `npm audit` gate.
//
// `moon run root:audit` (part of `root:check`) runs this instead of a bare
// `npm audit --audit-level=low` so the strict low threshold is preserved while
// exactly one unfixable upstream advisory is allowlisted:
//
//   GHSA-jfc7-64v2-mr8c — @sigstore/core DSSE payloadType type-binding failure.
//   Pulled transitively by the required @actions/attest runtime dependency via
//   @sigstore/sign; marked "No fix available" upstream, so no version bump or
//   `overrides` entry can resolve it.
//
// Any advisory whose source GHSA id is NOT in ALLOWLIST fails the gate,
// regardless of severity — so a new or unrelated advisory still breaks CI.
import { execFileSync } from 'node:child_process'

const ALLOWLIST = new Set(['GHSA-jfc7-64v2-mr8c'])

let stdout
try {
  // npm audit exits non-zero whenever advisories exist; the JSON report is
  // still written to stdout, which we capture from the thrown error.
  stdout = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8' })
} catch (error) {
  stdout = error.stdout
}

if (!stdout) {
  console.error('audit: npm produced no report on stdout')
  process.exit(1)
}

const report = JSON.parse(stdout)
const vulnerabilities = report.vulnerabilities ?? {}
const unexpected = []

for (const [name, record] of Object.entries(vulnerabilities)) {
  for (const via of record.via ?? []) {
    // String `via` entries are dependency-chain links; only object entries
    // carry a source advisory (with a GHSA url).
    if (typeof via !== 'object' || !via.url) continue
    const id = via.url.split('/').pop()
    if (!ALLOWLIST.has(id)) {
      unexpected.push(`${name}: ${via.title ?? id} (${via.url})`)
    }
  }
}

if (unexpected.length > 0) {
  console.error('audit: advisories outside the allowlist:')
  for (const line of unexpected) console.error(`  - ${line}`)
  process.exit(1)
}

const total = report.metadata?.vulnerabilities?.total ?? 0
console.log(
  `audit: ${total} advisory record(s), all tracing to allowlisted ` +
    'GHSA-jfc7-64v2-mr8c. OK.'
)
