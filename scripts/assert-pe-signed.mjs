#!/usr/bin/env node
// Assert a Windows PE file carries an Authenticode signature — from any OS.
//
// The macOS sign relay cannot run Get-AuthenticodeSignature, so after Jenkins
// returns a file this checks the PE optional header's security directory
// (data directory #4): a signed PE has a non-zero certificate table offset and
// size. This does not validate the chain (the Windows packaging job does that
// for payload exes); it catches the failure mode where the signing service
// returns bytes it never signed.
//
// Usage: node assert-pe-signed.mjs <file.exe>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node assert-pe-signed.mjs <file.exe>");
  process.exit(2);
}

const buf = readFileSync(file);
if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
  console.error(`::error ::${file}: not a PE file (missing MZ header)`);
  process.exit(1);
}
const peOffset = buf.readUInt32LE(0x3c);
if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
  console.error(`::error ::${file}: PE signature not found`);
  process.exit(1);
}
const optHeader = peOffset + 24;
const magic = buf.readUInt16LE(optHeader);
// PE32 keeps data directories at +96, PE32+ at +112.
const dirOffset = magic === 0x20b ? optHeader + 112 : optHeader + 96;
const securityDir = dirOffset + 4 * 8; // directory index 4 = certificate table
if (securityDir + 8 > buf.length) {
  console.error(`::error ::${file}: optional header truncated`);
  process.exit(1);
}
const certOffset = buf.readUInt32LE(securityDir);
const certSize = buf.readUInt32LE(securityDir + 4);
if (certOffset === 0 || certSize === 0) {
  console.error(`::error ::${file}: no Authenticode certificate table — file is unsigned`);
  process.exit(1);
}
console.log(`${file}: Authenticode certificate table present (${certSize} bytes at 0x${certOffset.toString(16)})`);
