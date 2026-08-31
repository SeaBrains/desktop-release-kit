#!/usr/bin/env node
// Rewrite electron-builder's Windows updater manifest for the SIGNED installer.
//
// The latest.yml shipped alongside the installer artifact predates signing, so
// its sha512/size are stale. Parse and rewrite it structurally: prefix every
// relative url/path — including the NSIS differential-update `packages`
// entries — with the version dir, and refresh hash/size only on the entry that
// names the signed installer (packages entries keep electron-builder's own
// values).
//
// Lives in scripts/ so the ESM `yaml` import resolves from the sibling
// node_modules (npm install --prefix scripts); NODE_PATH is ignored by ESM.
//
// Usage: node scripts/rewrite-windows-update-manifest.mjs \
//          --installer <signed.exe> --manifest <latest.yml> --version <x.y.z>
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parse, stringify } from 'yaml'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const installer = args.get('--installer')
const manifestPath = args.get('--manifest')
const version = args.get('--version')
if (!installer || !manifestPath || !version) {
  console.error('usage: rewrite-windows-update-manifest.mjs --installer <exe> --manifest <yml> --version <version>')
  process.exit(2)
}

const name = basename(installer)
const sha512 = createHash('sha512').update(readFileSync(installer)).digest('base64')
const size = statSync(installer).size

const manifest = parse(readFileSync(manifestPath, 'utf8'))

if (manifest.version !== version) {
  console.error(`::error ::${basename(manifestPath)} version ${manifest.version} != ${version}`)
  process.exit(1)
}

// Prefix every relative url/path with the version directory.
const prefixIfRelative = (value) => (typeof value === 'string' && !value.includes('/') ? `${version}/${value}` : value)
for (const entry of manifest.files ?? []) {
  if (entry && typeof entry === 'object') {
    if (typeof entry.url === 'string') entry.url = prefixIfRelative(entry.url)
    if (typeof entry.path === 'string') entry.path = prefixIfRelative(entry.path)
  }
}
if (typeof manifest.path === 'string') manifest.path = prefixIfRelative(manifest.path)
if (manifest.packages && typeof manifest.packages === 'object') {
  for (const pkg of Object.values(manifest.packages)) {
    if (pkg && typeof pkg === 'object' && typeof pkg.path === 'string') pkg.path = prefixIfRelative(pkg.path)
  }
}

// Refresh hash/size only on entries that describe the signed installer.
let touched = 0
for (const entry of manifest.files ?? []) {
  if (entry && typeof entry === 'object' && typeof entry.url === 'string' && entry.url.split('/').pop() === name) {
    entry.sha512 = sha512
    entry.size = size
    touched += 1
  }
}
if (typeof manifest.path === 'string' && manifest.path.split('/').pop() === name) {
  manifest.sha512 = sha512
  manifest.size = size
}
if (touched === 0) {
  console.error(`::error ::${basename(manifestPath)} has no files entry for ${name}`)
  process.exit(1)
}

writeFileSync(manifestPath, stringify(manifest))
console.log(`${basename(manifestPath)} rewritten for signed ${name} (${size} bytes)`)
