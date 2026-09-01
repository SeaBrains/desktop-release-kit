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

test('accepts any shutdown handoff name, not just prepareToQuit', () => {
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => { this.beginShutdown(); autoUpdater.quitAndInstall(false, true); });
  `)
  assert.equal(run(root).code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('rejects quitAndInstall without a preceding shutdown handoff', () => {
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => { autoUpdater.quitAndInstall(false, true); });
  `)
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /not immediately preceded by a shutdown handoff call/u)
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

test('rejects a forced exit scheduled after quitAndInstall', () => {
  // The real incident shape: a setTimeout(app.exit) "fallback" beheads
  // Squirrel's install chain, which runs in the old process for seconds.
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => {
      this.prepareToQuit();
      autoUpdater.quitAndInstall(false, true);
      setTimeout(() => app.exit(0), 3_000);
    });
  `)
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /forced exit .* follows quitAndInstall/u)
  rmSync(root, { recursive: true, force: true })
})

test('rejects an exit scheduled after an interposed nested block', () => {
  // A nested block whose `}` closes before the exit must not truncate the
  // scan window: the exit still sits in the same enclosing block.
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => {
      this.prepareToQuit();
      autoUpdater.quitAndInstall(false, true);
      if (debug) { log('installing'); }
      setTimeout(() => app.exit(0), 3_000);
    });
  `)
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /forced exit .* follows quitAndInstall/u)
  rmSync(root, { recursive: true, force: true })
})

test('rejects an exit separated from the install call by long filler', () => {
  const filler = Array.from({ length: 40 }, (_, i) => `log('step ${i} of the teardown sequence');`).join('\n      ')
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => {
      this.prepareToQuit();
      autoUpdater.quitAndInstall(false, true);
      ${filler}
      process.exit(0);
    });
  `)
  const { code, output } = run(root)
  assert.equal(code, 1)
  assert.match(output, /forced exit .* follows quitAndInstall/u)
  rmSync(root, { recursive: true, force: true })
})

test('string literals neither hide code nor read as code', () => {
  // A "//"-bearing string must not swallow the rest of a minified line, and
  // an "app.exit(0)" inside a string must not count as a call.
  const hidden = appWith(
    'autoUpdater.autoInstallOnAppQuit=!1;setImmediate(()=>{p.prepareToQuit();autoUpdater.quitAndInstall(!1,!0);log("see https://example.com/docs");setTimeout(()=>app.exit(0),3e3)});',
  )
  const hiddenResult = run(hidden)
  assert.equal(hiddenResult.code, 1)
  assert.match(hiddenResult.output, /forced exit .* follows quitAndInstall/u)
  rmSync(hidden, { recursive: true, force: true })

  const prose = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => { this.prepareToQuit(); autoUpdater.quitAndInstall(false, true); log("never call app.exit(0) here"); });
  `)
  assert.equal(run(prose).code, 0)
  rmSync(prose, { recursive: true, force: true })
})

test('allows app.exit in an adjacent block after the install callback closes', () => {
  const root = appWith(`
    autoUpdater.autoInstallOnAppQuit = false;
    setImmediate(() => { this.prepareToQuit(); autoUpdater.quitAndInstall(false, true); });
    function escalate() { app.exit(1); }
  `)
  assert.equal(run(root).code, 0)
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

// --- --lib-root mode (compiled shell sources) ---

function libWith(updaterSource, mainSource) {
  const root = mkdtempSync(join(tmpdir(), 'updater-lib-'))
  writeFileSync(join(root, 'updater.js'), updaterSource)
  writeFileSync(join(root, 'main.js'), mainSource)
  return root
}

function runLib(root) {
  try {
    execFileSync(process.execPath, [script, '--lib-root', root], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, output: '' }
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const LIB_UPDATER = `
  autoUpdater.autoInstallOnAppQuit = false;
  beginShutdown(() => {
    autoUpdater.quitAndInstall(false, true);
  });
`
const LIB_MAIN = `
  app.on('before-quit', (e) => { if (disposing) return; e.preventDefault(); requestShutdown(() => onDisposed()); });
  function onDisposed() {}
`

test('lib-root accepts compliant updater.js + main.js', () => {
  const root = libWith(LIB_UPDATER, LIB_MAIN)
  assert.equal(runLib(root).code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('lib-root rejects a forced exit after quitAndInstall inside the handoff', () => {
  const root = libWith(
    `
    autoUpdater.autoInstallOnAppQuit = false;
    beginShutdown(() => {
      autoUpdater.quitAndInstall(false, true);
      setTimeout(() => app.exit(0), 3_000);
    });
    `,
    LIB_MAIN,
  )
  const { code, output } = runLib(root)
  assert.equal(code, 1)
  assert.match(output, /forced exit .* follows quitAndInstall/u)
  rmSync(root, { recursive: true, force: true })
})

test('lib-root accepts comments between beginShutdown and quitAndInstall', () => {
  const root = libWith(
    `
    autoUpdater.autoInstallOnAppQuit = false;
    beginShutdown(() => {
      // Squirrel's chain runs in this process; let it drive the exit.
      autoUpdater.quitAndInstall(false, true);
    });
    `,
    LIB_MAIN,
  )
  assert.equal(runLib(root).code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('lib-root rejects a bare quitAndInstall outside the handoff', () => {
  const root = libWith(
    'autoUpdater.autoInstallOnAppQuit = false;\nautoUpdater.quitAndInstall(false, true);',
    LIB_MAIN,
  )
  const { code, output } = runLib(root)
  assert.equal(code, 1)
  assert.match(output, /quitAndInstall is not wrapped in the beginShutdown handoff/u)
  rmSync(root, { recursive: true, force: true })
})

test('lib-root rejects main.js without a disposing pass-through', () => {
  const root = libWith(LIB_UPDATER, "app.on('quit', () => process.exit(0));")
  const { code, output } = runLib(root)
  assert.equal(code, 1)
  assert.match(output, /before-quit handler does not return early while disposing/u)
  rmSync(root, { recursive: true, force: true })
})

test('rejects when neither --app-root nor --lib-root is given', () => {
  try {
    execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' })
    assert.fail('should have exited nonzero')
  } catch (error) {
    assert.equal(error.status, 2)
  }
})
