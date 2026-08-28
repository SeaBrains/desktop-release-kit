import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const script = join(dirname(fileURLToPath(import.meta.url)), 'verify-updater-contract.mjs')

/** Build a throwaway .app whose unpacked runtime holds the given source. */
function appWith(source, { path = 'lib/runtime.js' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'updater-contract-'))
  const file = join(root, 'Contents', 'Resources', 'app.asar.unpacked', path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, source)
  return root
}

function run(root) {
  try {
    execFileSync(process.execPath, [script, '--app-root', root], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, output: '' }
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const COMPLIANT = `
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  setImmediate(() => { this.prepareToQuit(); autoUpdater.quitAndInstall(false, true); });
`

test('accepts a runtime that raises the quit flag before installing', () => {
  const root = appWith(COMPLIANT)
  assert.equal(run(root).code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('accepts minified output', () => {
  const root = appWith(
    'autoUpdater.autoInstallOnAppQuit=!1;setImmediate(()=>{this.prepareToQuit();autoUpdater.quitAndInstall(!1,!0)});',
  )
  assert.equal(run(root).code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('rejects quitAndInstall without a preceding prepareToQuit', () => {
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => { autoUpdater.quitAndInstall(false, true); });
  `)
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /not immediately preceded by prepareToQuit/u)
  rmSync(root, { recursive: true, force: true })
})

test('rejects autoInstallOnAppQuit set true', () => {
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = true;
    setImmediate(() => { this.prepareToQuit(); autoUpdater.quitAndInstall(false, true); });
  `)
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /autoInstallOnAppQuit is set true/u)
  rmSync(root, { recursive: true, force: true })
})

test('rejects a runtime that never sets autoInstallOnAppQuit', () => {
  const root = appWith('setImmediate(() => { this.prepareToQuit(); autoUpdater.quitAndInstall(false, true); });')
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /never set false/u)
  rmSync(root, { recursive: true, force: true })
})

test('ignores electron-updater library sources that define the defaults', () => {
  // The library's own AppUpdater.js assigns autoInstallOnAppQuit = true; scanning it
  // would fail every compliant build.
  const root = appWith(COMPLIANT)
  const lib = join(root, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'electron-updater', 'out', 'AppUpdater.js')
  mkdirSync(dirname(lib), { recursive: true })
  writeFileSync(lib, 'this.autoInstallOnAppQuit = true;\nquitAndInstall(isSilent, isForceRunAfter) {}')
  assert.equal(run(root).code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('fails when no product chunk calls the updater at all', () => {
  const root = appWith('export const noop = 1')
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /no product chunk calling autoUpdater\.quitAndInstall/u)
  rmSync(root, { recursive: true, force: true })
})
