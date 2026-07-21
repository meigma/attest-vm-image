// Scoped `npm audit` gate.
//
// `moon run root:audit` (part of `root:check`) runs this instead of a bare
// `npm audit --audit-level=low` so a strict low threshold can coexist with an
// explicit, reviewable allowlist for advisories that have no upstream fix.
//
// The allowlist is currently EMPTY: the one advisory this repo has had to deal
// with (GHSA-jfc7-64v2-mr8c, @sigstore/core DSSE payloadType type-binding
// failure, pulled transitively by @actions/attest) is resolved by the
// `overrides` block in package.json forcing @sigstore/sign@^5 /
// @sigstore/bundle@^5, which resolve the fixed @sigstore/core@^4.0.1. If that
// override ever regresses, the advisory reappears and this gate fails.
//
// To allowlist a future unfixable advisory, add its GHSA id here with a
// comment justifying it; any advisory whose source GHSA id is NOT in ALLOWLIST
// fails the gate regardless of severity.
import { execFileSync } from 'node:child_process'

const ALLOWLIST = new Set([])

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
  total === 0
    ? 'audit: no advisories. OK.'
    : `audit: ${total} advisory record(s), all allowlisted. OK.`
)
