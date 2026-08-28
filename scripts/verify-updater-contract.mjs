#!/usr/bin/env node
// Gate the two macOS auto-update contracts that a green pipeline cannot otherwise
// catch: both failure modes ship a correctly signed, notarized package whose
// update simply never installs.
//
//   1. quitAndInstall() reaches app.quit(), but a shell that hides its window on
//      'close' until a quitting flag is set will preventDefault() that quit. The
//      process stays in its run loop and Squirrel's ShipIt helper waits forever
//      for an exit that never comes.
//   2. MacUpdater.quitAndInstall() only calls nativeUpdater.checkForUpdates() —
//      the step that makes native Squirrel stage the zip and write
//      ShipItState.plist — while autoInstallOnAppQuit is false. Setting it true
//      skips that call, so ShipIt finds no state to install and retries forever.
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

  // The quit flag must be raised in the same statement sequence as the install
  // call. Allow minified and formatted output, but not a distant unrelated call.
  const handoff = /prepareToQuit\(\)\s*;?\s*(?:\/\*[\s\S]*?\*\/\s*)?autoUpdater\.quitAndInstall/u
  if (!handoff.test(text)) {
    failures.push(`${path}: quitAndInstall is not immediately preceded by prepareToQuit()`)
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
