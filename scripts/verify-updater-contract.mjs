#!/usr/bin/env node
// Gate the two macOS auto-update contracts that a green pipeline cannot
// otherwise catch: both failure modes ship a correctly signed, notarized
// package whose update simply never installs.
//
//   1. quitAndInstall() drives app.quit(). The shell's shutdown handler
//      preventDefault()s the quit and starts its own teardown, which must be
//      allowed to finish before the update install runs. The install call
//      therefore has to sit in the same statement sequence as a shutdown
//      handoff — never bare on its own. The handoff's name is product-specific
//      (prepareToQuit / beginShutdown / requestShutdown…), so the gate accepts
//      any preceding method call instead of coupling to one app's naming.
//   2. MacUpdater decides who triggers the native checkForUpdates() that makes
//      Squirrel stage the zip and write ShipItState.plist based on
//      autoInstallOnAppQuit (MacUpdater.js). With `true` it fires the moment
//      the download finishes — staging an install the user has not agreed to,
//      and its quitAndInstall path then bypasses the app's own disposal. It
//      must be `false` so the trigger stays inside quitAndInstall(), after the
//      handoff.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])

const root = args.get('--app-root')
if (root === undefined) {
  console.error('verify-updater-contract: --app-root <path-to-.app> is required')
  process.exit(2)
}

/** Walk for the bundled runtime chunk that configures electron-updater. */
function findRuntimeChunks(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) findRuntimeChunks(path, out)
    else if (entry.isFile() && entry.name.endsWith('.js') && statSync(path).size < 4_000_000) out.push(path)
  }
  return out
}

const unpacked = join(root, 'Contents', 'Resources', 'app.asar.unpacked')
// Only the product's own bundle is in scope. electron-updater's own sources
// define the library defaults (including autoInstallOnAppQuit = true) and would
// otherwise trip every assertion below.
const sources = findRuntimeChunks(unpacked).filter(path => {
  if (path.includes(`${sep}node_modules${sep}`)) return false
  return readFileSync(path, 'utf8').includes('autoUpdater.quitAndInstall')
})

if (sources.length === 0) {
  console.error(`verify-updater-contract: no product chunk calling autoUpdater.quitAndInstall under ${unpacked}`)
  console.error('If the runtime lives inside app.asar rather than app.asar.unpacked, extract it before this gate.')
  process.exit(1)
}

const failures = []
for (const path of sources) {
  const text = readFileSync(path, 'utf8')

  // The shutdown handoff must be raised in the same statement sequence as the
  // install call. Accept any preceding method call — the handoff name is
  // product-specific, so binding to prepareToQuit() or beginShutdown() would
  // couple the gate to one app's naming. Allow minified and formatted output,
  // but not a bare quitAndInstall.
  const handoff = /(?:[\w$]+\.)?[\w$]+\([^)]*\)\s*;?\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:[\w$]+\.)?(?:autoUpdater\.)?quitAndInstall/u
  if (!handoff.test(text)) {
    failures.push(`${path}: quitAndInstall is not immediately preceded by a shutdown handoff call`)
  }

  if (/autoInstallOnAppQuit\s*=\s*(?:true|!0)\b/u.test(text)) {
    failures.push(`${path}: autoInstallOnAppQuit is set true; macOS installs require false`)
  }
  if (!/autoInstallOnAppQuit\s*=\s*(?:false|!1)\b/u.test(text)) {
    failures.push(`${path}: autoInstallOnAppQuit is never set false`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error ::verify-updater-contract: ${failure}`)
  process.exit(1)
}

console.log(`verify-updater-contract: ${sources.length} runtime chunk(s) satisfy the macOS install handoff contract`)
