#!/usr/bin/env node
// Fetch every artifact the updater manifest points at and check the bytes.
//
// A HEAD request is not enough: a CDN can answer HEAD from bucket metadata while
// GET falls through to an SPA rewrite, so the manifest looks healthy and clients
// download a 27 KB HTML page instead of a 265 MB disk image. Only a real GET with
// a hash comparison distinguishes the two.
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])

const manifestPath = args.get('--manifest')
const base = args.get('--base')?.replace(/\/+$/u, '')
const maxBytes = Number(args.get('--max-bytes') ?? 0)
if (manifestPath === undefined || base === undefined) {
  console.error('verify-published-artifacts: --manifest <path> --base <cdn-url> are required')
  process.exit(2)
}

const manifest = parse(readFileSync(manifestPath, 'utf8'))
const entries = Array.isArray(manifest.files) ? manifest.files : []
if (entries.length === 0) {
  console.error('::error ::verify-published-artifacts: manifest lists no files')
  process.exit(1)
}

const failures = []
for (const entry of entries) {
  const url = `${base}/${String(entry.url).split('/').map(encodeURIComponent).join('/')}`
  let response
  try {
    response = await fetch(url)
  } catch (cause) {
    failures.push(`${entry.url}: request failed (${cause instanceof Error ? cause.message : cause})`)
    continue
  }
  if (!response.ok) {
    failures.push(`${entry.url}: HTTP ${response.status}`)
    continue
  }

  // A rewrite to the marketing site answers 200 with HTML; catch it before hashing.
  const type = response.headers.get('content-type') ?? ''
  if (/^text\/html/u.test(type)) {
    failures.push(`${entry.url}: CDN served HTML (${type}), not the artifact — check rewrite rules`)
    continue
  }

  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    hash.update(chunk)
    if (maxBytes > 0 && size > maxBytes) break
  }

  if (maxBytes > 0 && size > maxBytes) {
    console.log(`verify-published-artifacts: ${entry.url} streamed ${size} bytes (probe limit), skipping hash`)
    continue
  }
  if (typeof entry.size === 'number' && size !== entry.size) {
    failures.push(`${entry.url}: served ${size} bytes, manifest declares ${entry.size}`)
    continue
  }
  const digest = hash.digest('base64')
  if (typeof entry.sha512 === 'string' && digest !== entry.sha512) {
    failures.push(`${entry.url}: sha512 mismatch (updater will reject this download)`)
    continue
  }
  console.log(`verify-published-artifacts: ${entry.url} ok (${size} bytes, sha512 verified)`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error ::verify-published-artifacts: ${failure}`)
  process.exit(1)
}
