#!/usr/bin/env node
// Gate the macOS auto-update handoff contracts that a green pipeline cannot
// otherwise catch: each failure mode ships a correctly signed, notarized
// package whose update simply never installs.
//
// Two modes, one contract:
//
//   --app-root <path-to-.app>   scan the packaged bundle (app.asar.unpacked)
//   --lib-root <path-to-lib>    scan the compiled shell sources (updater.js +
//                               main.js) — for products that keep runtime JS
//                               inside app.asar with no asarUnpack
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

const appRoot = args.get('--app-root')
const libRoot = args.get('--lib-root')
if (appRoot === undefined && libRoot === undefined) {
  console.error('verify-updater-contract: --app-root <path-to-.app> or --lib-root <path-to-compiled-lib> is required')
  process.exit(2)
}

const failures = []

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

function checkAppRoot() {
  const unpacked = join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked')
  // Only the product's own bundle is in scope. electron-updater's own sources
  // define the library defaults (including autoInstallOnAppQuit = true) and would
  // otherwise trip every assertion below.
  const sources = findRuntimeChunks(unpacked).filter(path => {
    if (path.includes(`${sep}node_modules${sep}`)) return false
    return readFileSync(path, 'utf8').includes('autoUpdater.quitAndInstall')
  })

  if (sources.length === 0) {
    console.error(`verify-updater-contract: no product chunk calling autoUpdater.quitAndInstall under ${unpacked}`)
    console.error('If the runtime lives inside app.asar rather than app.asar.unpacked, use --lib-root against the compiled sources.')
    process.exit(1)
  }

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
}

function checkLibRoot() {
  const updater = readFileSync(join(libRoot, 'updater.js'), 'utf8')
  if (!/autoInstallOnAppQuit\s*=\s*(?:false|!1)\b/u.test(updater)) {
    failures.push('updater.js: autoInstallOnAppQuit is never set false')
  }
  if (/autoInstallOnAppQuit\s*=\s*(?:true|!0)\b/u.test(updater)) {
    failures.push('updater.js: autoInstallOnAppQuit is set true; macOS installs require false')
  }
  const installCalls = [...updater.matchAll(/quitAndInstall/gu)].length
  if (installCalls === 0) {
    failures.push('updater.js: no quitAndInstall call found')
  }
  // Every install call must sit inside the beginShutdown handoff callback.
  const handoff = /beginShutdown\(\s*(?:\(\)\s*=>|function\s*\(\s*\))\s*\{\s*(?:[\w$]+\.)?(?:autoUpdater\.)?quitAndInstall/u
  if (installCalls > 0 && !handoff.test(updater)) {
    failures.push('updater.js: quitAndInstall is not wrapped in the beginShutdown handoff')
  }

  const main = readFileSync(join(libRoot, 'main.js'), 'utf8')
  // The before-quit handler must let a shutdown-in-progress quit pass through:
  // its first act is returning when `disposing` is already set. Without that,
  // the quit driven by quitAndInstall is swallowed and ShipIt waits forever.
  const beforeQuit = /before-quit'?\s*,\s*\((\w+)\)\s*=>\s*\{\s*if\s*\(disposing\)\s*return/u
  if (!beforeQuit.test(main)) {
    failures.push('main.js: before-quit handler does not return early while disposing')
  }
  if (!/onDisposed\s*\(\)/u.test(main)) {
    failures.push('main.js: requestShutdown has no onDisposed handoff (updater would be hard-killed)')
  }
}

if (libRoot !== undefined) {
  checkLibRoot()
} else {
  checkAppRoot()
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error ::verify-updater-contract: ${failure}`)
  process.exit(1)
}

console.log('verify-updater-contract: macOS install handoff contracts hold')
