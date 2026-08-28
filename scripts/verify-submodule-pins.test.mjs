import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const script = join(dirname(fileURLToPath(import.meta.url)), 'verify-submodule-pins.mjs')

/** A repository whose index records `submodule` as a gitlink at `commit`. */
function repoWithGitlink(commit) {
  const root = mkdtempSync(join(tmpdir(), 'submodule-pin-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${commit},vendor/upstream`], {
    cwd: root,
    stdio: 'pipe',
  })
  return root
}

function run(root, manifest, submodule = 'vendor/upstream') {
  try {
    const stdout = execFileSync(process.execPath, [script, '--manifest', manifest, '--submodule', submodule], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const PINNED = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
const OTHER = '0001813f9fc3c32118406b4976e68c7a9c897372'

test('passes when the manifest matches the index', () => {
  const root = repoWithGitlink(PINNED)
  writeFileSync(join(root, 'upstream.json'), JSON.stringify({ commit: PINNED }))
  assert.equal(run(root, 'upstream.json').code, 0)
  rmSync(root, { recursive: true, force: true })
})

test('fails when the manifest names a different commit', () => {
  const root = repoWithGitlink(PINNED)
  writeFileSync(join(root, 'upstream.json'), JSON.stringify({ commit: OTHER }))
  const { code, output } = run(root, 'upstream.json')
  assert.equal(code, 1)
  assert.match(output, new RegExp(`index is ${PINNED}, but upstream\\.json declares ${OTHER}`, 'u'))
  rmSync(root, { recursive: true, force: true })
})

test('skips silently when the product has no pin manifest', () => {
  const root = repoWithGitlink(PINNED)
  const { code, output } = run(root, 'absent.json')
  assert.equal(code, 0)
  assert.match(output, /absent, nothing to check/u)
  rmSync(root, { recursive: true, force: true })
})

test('fails when the manifest has no commit field', () => {
  const root = repoWithGitlink(PINNED)
  writeFileSync(join(root, 'upstream.json'), JSON.stringify({ sourceVersion: '1.0.0' }))
  const { code, output } = run(root, 'upstream.json')
  assert.equal(code, 1)
  assert.match(output, /no "commit" field/u)
  rmSync(root, { recursive: true, force: true })
})

test('fails when the path is not tracked as a submodule', () => {
  const root = repoWithGitlink(PINNED)
  mkdirSync(join(root, 'plain'), { recursive: true })
  writeFileSync(join(root, 'upstream.json'), JSON.stringify({ commit: PINNED }))
  const { code, output } = run(root, 'upstream.json', 'plain')
  assert.equal(code, 1)
  assert.match(output, /not tracked in the index/u)
  rmSync(root, { recursive: true, force: true })
})
