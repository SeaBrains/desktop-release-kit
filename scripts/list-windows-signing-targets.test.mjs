import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./list-windows-signing-targets.mjs", import.meta.url));

function run(root, env) {
  return spawnSync(process.execPath, [script, "--root", root], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("list-windows-signing-targets requires RELEASE_EXECUTABLE_NAME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-sign-"));
  try {
    const result = run(dir, { RELEASE_EXECUTABLE_NAME: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RELEASE_EXECUTABLE_NAME env var is required/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("list-windows-signing-targets prints the env-named executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "win-sign-"));
  try {
    const exe = join(dir, "SeaHarness.exe");
    await writeFile(exe, "fake");
    const result = run(dir, { RELEASE_EXECUTABLE_NAME: "SeaHarness.exe" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), exe);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
