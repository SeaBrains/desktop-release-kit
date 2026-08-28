#!/usr/bin/env node
// Fail fast when a product's pin manifest and its Git submodule index disagree.
//
// The product's own layout gate catches this too, but only after the macOS job has
// already spent ~20 minutes signing and notarizing. The mismatch is knowable in
// seconds from the index alone, so check it before any packaging work starts.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])

const manifestPath = args.get('--manifest')
const submodule = args.get('--submodule')
if (manifestPath === undefined || submodule === undefined) {
  console.error('verify-submodule-pins: --manifest <path> --submodule <path> are required')
  process.exit(2)
}

// The pin manifest is optional: products without a vendored upstream skip this gate.
if (!existsSync(manifestPath)) {
  console.log(`verify-submodule-pins: ${manifestPath} absent, nothing to check`)
  process.exit(0)
}

let declared
try {
  declared = JSON.parse(readFileSync(manifestPath, 'utf8')).commit
} catch (cause) {
  console.error(`::error ::verify-submodule-pins: cannot parse ${manifestPath}: ${cause instanceof Error ? cause.message : cause}`)
  process.exit(1)
}
if (typeof declared !== 'string' || declared.length === 0) {
  console.error(`::error ::verify-submodule-pins: ${manifestPath} has no "commit" field`)
  process.exit(1)
}

let staged
try {
  staged = execFileSync('git', ['ls-files', '--stage', '--', submodule], { encoding: 'utf8' }).trim()
} catch (cause) {
  console.error(`::error ::verify-submodule-pins: git ls-files failed: ${cause instanceof Error ? cause.message : cause}`)
  process.exit(1)
}
if (staged.length === 0) {
  console.error(`::error ::verify-submodule-pins: ${submodule} is not tracked in the index`)
  process.exit(1)
}

const [mode, indexed] = staged.split(/\s+/u)
if (mode !== '160000') {
  console.error(`::error ::verify-submodule-pins: ${submodule} is not a gitlink (mode ${mode})`)
  process.exit(1)
}
if (indexed !== declared) {
  console.error(`::error ::verify-submodule-pins: ${submodule} index is ${indexed}, but ${manifestPath} declares ${declared}`)
  console.error('::error ::Update whichever side is stale; a release built from this tree would fail the product layout gate after packaging.')
  process.exit(1)
}

console.log(`verify-submodule-pins: ${submodule} matches ${manifestPath} at ${indexed}`)
