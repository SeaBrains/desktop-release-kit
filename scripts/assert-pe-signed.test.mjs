import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./assert-pe-signed.mjs", import.meta.url));

/** Build a minimal PE32+ with a chosen certificate table entry. */
function buildPe({ certOffset, certSize }) {
  const buf = Buffer.alloc(0x200);
  buf.write("MZ", 0, "ascii");
  const peOffset = 0x80;
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write("PE\0\0", peOffset, "ascii");
  const optHeader = peOffset + 24;
  buf.writeUInt16LE(0x20b, optHeader); // PE32+
  const securityDir = optHeader + 112 + 4 * 8;
  buf.writeUInt32LE(certOffset, securityDir);
  buf.writeUInt32LE(certSize, securityDir + 4);
  return buf;
}

function run(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "pe-"));
  const file = join(dir, "probe.exe");
  writeFileSync(file, bytes);
  try {
    return { code: 0, output: execFileSync(process.execPath, [script, file], { encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status, output: `${error.stdout}${error.stderr}` };
  }
}

test("accepts a PE with a certificate table", () => {
  const result = run(buildPe({ certOffset: 0x180, certSize: 64 }));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /certificate table present/u);
});

test("rejects a PE without a certificate table", () => {
  const result = run(buildPe({ certOffset: 0, certSize: 0 }));
  assert.equal(result.code, 1);
  assert.match(result.output, /unsigned/u);
});

test("rejects a non-PE file", () => {
  const result = run(Buffer.from("not an executable"));
  assert.equal(result.code, 1);
  assert.match(result.output, /not a PE file/u);
});
