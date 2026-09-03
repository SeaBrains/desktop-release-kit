#!/usr/bin/env node
// Gate the macOS auto-update handoff contracts that a green pipeline cannot
// otherwise catch: each failure mode ships a correctly signed, notarized
// package whose update simply never installs.
//
// Three modes, one contract:
//
//   --app-root <path-to-.app>           scan the packaged bundle (app.asar.unpacked)
//   --lib-root <path-to-lib>            scan the compiled shell sources (updater.js +
//                                       main.js) — for products that keep runtime JS
//                                       inside app.asar with no asarUnpack
//   --bundle-root <path-to-output-dir>  scan a compiled output directory with the
//                                       same generic assertions as app-root — for
//                                       single-file bundles with no asarUnpack
//                                       (e.g. electron-vite index.cjs)
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
//   3. quitAndInstall() starts Squirrel's install chain IN the old process —
//      fetch the staged zip from the local proxy, unpack, verify, submit the
//      install to ShipIt, then terminate the app. That takes seconds for a
//      150MB+ zip, so a forced exit scheduled after the call (app.exit /
//      process.exit in a setTimeout) beheads the chain before ShipIt is even
//      submitted: the staged bundle sits complete in the ShipIt cache, no
//      ShipIt log, no swap, and the pipeline behind it is green. The process
//      must exit only through Squirrel's own terminate.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])

const appRoot = args.get('--app-root')
const libRoot = args.get('--lib-root')
const bundleRoot = args.get('--bundle-root')
if (appRoot === undefined && libRoot === undefined && bundleRoot === undefined) {
  console.error('verify-updater-contract: --app-root <path-to-.app>, --lib-root <path-to-compiled-lib>, or --bundle-root <path-to-compiled-output-dir> is required')
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
    else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name) && statSync(path).size < 4_000_000) out.push(path)
  }
  return out
}

function findProductInstallChunks(dir) {
  // Only the product's own bundle is in scope. electron-updater's own sources
  // define the library defaults (including autoInstallOnAppQuit = true) and would
  // otherwise trip every assertion below.
  return findRuntimeChunks(dir).filter(path => {
    if (path.includes(`${sep}node_modules${sep}`)) return false
    return readFileSync(path, 'utf8').includes('autoUpdater.quitAndInstall')
  })
}

function assertGenericInstallContracts(path, mode = 'app-root') {
  // Comments, strings, and regex literals are blanked so prose never reads as
  // code — in either direction: a comment saying "app.exit()" must not trip a
  // check, and a string containing "//" must not swallow the rest of the line.
  const text = blankNonCode(readFileSync(path, 'utf8'))

  // The shutdown handoff must be raised in the same statement sequence as the
  // install call. Accept any preceding method call — the handoff name is
  // product-specific, so binding to prepareToQuit() or beginShutdown() would
  // couple the gate to one app's naming. Allow minified and formatted output,
  // but not a bare quitAndInstall.
  const handoff = /(?:[\w$]+\.)?[\w$]+\([^)]*\)\s*;?\s*(?:[\w$]+\.)?(?:autoUpdater\.)?quitAndInstall/u
  if (!handoff.test(text)) {
    failures.push(`${path}: quitAndInstall is not immediately preceded by a shutdown handoff call`)
  }

  // bundle-root scans a single compiled file that may inline electron-updater.
  // The library constructor assigns `this.autoInstallOnAppQuit = true`; that is
  // not product code. Only a receiver that is exactly `this` is exempt —
  // `_this` (Babel), `self`, `a.this` all count as product assignments.
  // app-root still uses the unprefixed form — it already skipped node_modules
  // by path.
  if (mode === 'bundle-root') {
    if (productAutoInstallReceivers(text, 'true|!0').length > 0) {
      failures.push(`${path}: autoInstallOnAppQuit is set true; macOS installs require false`)
    }
    if (productAutoInstallReceivers(text, 'false|!1').length === 0) {
      failures.push(`${path}: autoInstallOnAppQuit is never set false`)
    }
  } else {
    if (/autoInstallOnAppQuit\s*=\s*(?:true|!0)\b/u.test(text)) {
      failures.push(`${path}: autoInstallOnAppQuit is set true; macOS installs require false`)
    }
    if (!/autoInstallOnAppQuit\s*=\s*(?:false|!1)\b/u.test(text)) {
      failures.push(`${path}: autoInstallOnAppQuit is never set false`)
    }
  }

  // Contract 3: nothing may force-exit after the install call. Squirrel's
  // chain (fetch → unpack → verify → submit to ShipIt → terminate) runs in
  // this process and takes seconds; a scheduled exit beheads it silently.
  if (forcedExitAfterInstall(text)) {
    failures.push(`${path}: a forced exit (app.exit/process.exit) follows quitAndInstall — Squirrel's install chain runs in the old process and must drive the exit itself`)
  }
}

function checkAppRoot() {
  const unpacked = join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked')
  const sources = findProductInstallChunks(unpacked)

  if (sources.length === 0) {
    console.error(`verify-updater-contract: no product chunk calling autoUpdater.quitAndInstall under ${unpacked}`)
    console.error('If the runtime lives inside app.asar rather than app.asar.unpacked, use --lib-root against the compiled sources.')
    process.exit(1)
  }

  for (const path of sources) assertGenericInstallContracts(path)
}

function checkBundleRoot() {
  const sources = findProductInstallChunks(bundleRoot)

  if (sources.length === 0) {
    console.error(`verify-updater-contract: no product chunk calling autoUpdater.quitAndInstall under ${bundleRoot}`)
    console.error('Confirm --bundle-root points at the compiled output directory.')
    process.exit(1)
  }

  for (const path of sources) assertGenericInstallContracts(path, 'bundle-root')
}

/** Receivers of `X.autoInstallOnAppQuit = <value>` that are not the literal `this`. */
function productAutoInstallReceivers(text, value) {
  const re = new RegExp(
    String.raw`([\w$]+(?:\.[\w$]+)*)\.autoInstallOnAppQuit\s*=\s*(?:${value})\b`,
    'gu',
  )
  return [...text.matchAll(re)].map(m => m[1]).filter(receiver => receiver !== 'this')
}

const REGEX_PREFIX_PUNCT = '(,=:[!&|?{;*%^~<'
const REGEX_PREFIX_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'case', 'do', 'else', 'yield', 'await',
])

/** True when `/` at `i` starts a regex literal rather than a division. */
function isRegexLiteralStart(source, i) {
  let k = i - 1
  while (k >= 0 && /\s/.test(source[k])) k -= 1
  if (k < 0) return true
  const prev = source[k]
  // Postfix ++/-- is a value, so the following `/` is division (`count++ / total`).
  // A lone `+`/`-` is still an operator, so `/` starts a regex.
  if (prev === '+' || prev === '-') {
    return !(k > 0 && source[k - 1] === prev)
  }
  // Only the arrow `=>` makes `>` a regex prefix; `a > b / c` is division.
  if (prev === '>') return k > 0 && source[k - 1] === '='
  if (REGEX_PREFIX_PUNCT.includes(prev)) return true
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let start = k
    while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start -= 1
    return REGEX_PREFIX_WORDS.has(source.slice(start, k + 1))
  }
  return false
}

/** Exclusive end index of a regex literal starting at `start` (the opening `/`). */
function scanRegexLiteral(source, start) {
  const n = source.length
  let i = start + 1
  let inClass = false
  while (i < n) {
    const c = source[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      i += 1
      continue
    }
    if (c === '[') {
      inClass = true
      i += 1
      continue
    }
    if (c === '/') {
      i += 1
      while (i < n && /[A-Za-z]/.test(source[i])) i += 1
      return i
    }
    i += 1
  }
  return n
}

/**
 * Blank comments, strings, template literals, and regex literals with spaces,
 * preserving offsets. Prose like "quitAndInstall() drives app.quit()" in a
 * comment, or a URL's `//` inside a string, must neither read as code nor
 * derail the scan. Regex literals must be recognized too: `/&#39;/g` contains
 * quotes that would otherwise desync the string walker.
 */
function blankNonCode(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      const stop = nl === -1 ? n : nl
      out += ' '.repeat(stop - i)
      i = stop
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += ' '.repeat(stop - i)
      i = stop
    } else if (c === '/' && isRegexLiteralStart(source, i)) {
      const stop = Math.min(scanRegexLiteral(source, i), n)
      out += ' '.repeat(stop - i)
      i = stop
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') j += 2
        else if (source[j] === c) { j += 1; break }
        else j += 1
      }
      out += ' '.repeat(Math.min(j, n) - i)
      i = j
    } else {
      out += c
      i += 1
    }
  }
  return out
}

/**
 * True when a forced exit follows any quitAndInstall call inside the same
 * block. Runs on blanked source, and the window is brace-depth aware: it
 * extends to the end of the enclosing block — through nested blocks like a
 * setTimeout callback or an if — so scheduling the exit later in the block
 * cannot slip past, while a legitimate app.exit in an adjacent function (e.g.
 * a shutdown grace-period escalation) stays out of scope.
 */
function forcedExitAfterInstall(source) {
  const text = blankNonCode(source)
  for (const match of text.matchAll(/quitAndInstall\s*\([^)]*\)/gu)) {
    const start = match.index + match[0].length
    let depth = 0
    let end = text.length
    for (let i = start; i < text.length; i += 1) {
      const c = text[i]
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth < 0) { end = i; break }
      }
    }
    if (/(?:app|process)\s*\.\s*exit\s*\(/u.test(text.slice(start, end))) return true
  }
  return false
}

function checkLibRoot() {
  // Blanked so comment prose never reads as code (an "app.exit()" mention
  // must not trip the exit check, nor count as a quitAndInstall call).
  const updater = blankNonCode(readFileSync(join(libRoot, 'updater.js'), 'utf8'))
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
  // Comments are already blanked to whitespace, so \s* absorbs them.
  const handoff = /beginShutdown\(\s*(?:\(\)\s*=>|function\s*\(\s*\))\s*\{\s*(?:[\w$]+\.)?(?:autoUpdater\.)?quitAndInstall/u
  if (installCalls > 0 && !handoff.test(updater)) {
    failures.push('updater.js: quitAndInstall is not wrapped in the beginShutdown handoff')
  }
  if (forcedExitAfterInstall(updater)) {
    failures.push("updater.js: a forced exit (app.exit/process.exit) follows quitAndInstall — Squirrel's install chain runs in the old process and must drive the exit itself")
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
} else if (bundleRoot !== undefined) {
  checkBundleRoot()
} else {
  checkAppRoot()
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error ::verify-updater-contract: ${failure}`)
  process.exit(1)
}

console.log('verify-updater-contract: macOS install handoff contracts hold')
