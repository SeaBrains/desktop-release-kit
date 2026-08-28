import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  generateDesktopUpdateManifestFromFile,
  prefixDesktopUpdatePath,
  prepareDesktopUpdateManifest,
} from "./prepare-desktop-update-manifest.mjs";

test("prefixDesktopUpdatePath prefixes relative updater asset paths", () => {
  assert.equal(
    prefixDesktopUpdatePath("DSH-Desktop-2.1.0-arm64.dmg", "2.1.0"),
    "2.1.0/DSH-Desktop-2.1.0-arm64.dmg",
  );
});

test("prefixDesktopUpdatePath is idempotent for already-prefixed paths", () => {
  assert.equal(
    prefixDesktopUpdatePath("2.1.0/DSH-Desktop-2.1.0-arm64.dmg", "2.1.0"),
    "2.1.0/DSH-Desktop-2.1.0-arm64.dmg",
  );
});

test("prefixDesktopUpdatePath leaves absolute updater URLs unchanged", () => {
  assert.equal(
    prefixDesktopUpdatePath("https://downloads.example.com/2.1.0/DSH-Desktop.dmg", "2.1.0"),
    "https://downloads.example.com/2.1.0/DSH-Desktop.dmg",
  );
});

test("prefixDesktopUpdatePath applies a GH release base URL when provided", () => {
  const base = "https://github.com/anywhere-labs/deepseek-harness-desktop/releases/download/v2.1.0";
  assert.equal(
    prefixDesktopUpdatePath("DSH-Desktop-2.1.0-Setup.exe", "2.1.0", base),
    `${base}/DSH-Desktop-2.1.0-Setup.exe`,
  );
});

test("prepareDesktopUpdateManifest rewrites file urls and top-level path", () => {
  const output = prepareDesktopUpdateManifest(
    [
      "version: 2.1.0",
      "files:",
      "  - url: DSH-Desktop-2.1.0-arm64.dmg",
      "    sha512: abc",
      "    size: 100",
      "  - url: DSH-Desktop-2.1.0-arm64.zip",
      "    sha512: def",
      "    size: 200",
      "path: DSH-Desktop-2.1.0-arm64.dmg",
      "sha512: abc",
      "releaseDate: '2026-04-15T11:40:25.893Z'",
      "",
    ].join("\n"),
    { version: "2.1.0" },
  );

  const manifest = parse(output);
  assert.equal(manifest.files[0].url, "2.1.0/DSH-Desktop-2.1.0-arm64.dmg");
  assert.equal(manifest.files[1].url, "2.1.0/DSH-Desktop-2.1.0-arm64.zip");
  assert.equal(manifest.path, "2.1.0/DSH-Desktop-2.1.0-arm64.dmg");
});

test("prepareDesktopUpdateManifest rewrites package paths", () => {
  const output = prepareDesktopUpdateManifest(
    [
      "version: 2.1.0",
      "files:",
      "  - url: DSH-Desktop-Setup-2.1.0.exe",
      "    sha512: abc",
      "packages:",
      "  x64:",
      "    path: dsh-package.7z",
      "    sha512: def",
      "",
    ].join("\n"),
    { version: "2.1.0" },
  );

  const manifest = parse(output);
  assert.equal(manifest.files[0].url, "2.1.0/DSH-Desktop-Setup-2.1.0.exe");
  assert.equal(manifest.packages.x64.path, "2.1.0/dsh-package.7z");
});

test("prepareDesktopUpdateManifest rewrites URLs under a GH release base URL", () => {
  const base = "https://github.com/anywhere-labs/deepseek-harness-desktop/releases/download/v2.1.0";
  const output = prepareDesktopUpdateManifest(
    [
      "version: 2.1.0",
      "files:",
      "  - url: DSH-Desktop-Setup-2.1.0.exe",
      "    sha512: abc",
      "path: DSH-Desktop-Setup-2.1.0.exe",
      "sha512: abc",
      "",
    ].join("\n"),
    { version: "2.1.0", baseUrl: base },
  );

  const manifest = parse(output);
  assert.equal(manifest.files[0].url, `${base}/DSH-Desktop-Setup-2.1.0.exe`);
  assert.equal(manifest.path, `${base}/DSH-Desktop-Setup-2.1.0.exe`);
});

test("prepareDesktopUpdateManifest fails on release version mismatch", () => {
  assert.throws(
    () => prepareDesktopUpdateManifest("version: 2.1.0\npath: DSH-Desktop.dmg\n", { version: "1.0.7" }),
    /does not match release version/,
  );
});

test("generateDesktopUpdateManifestFromFile creates a Windows installer manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-manifest-"));
  try {
    const installerPath = join(dir, "DSH-Desktop-Setup-2.1.0-rc.1.exe");
    await writeFile(installerPath, "fake installer content");

    const output = await generateDesktopUpdateManifestFromFile({
      filePath: installerPath,
      version: "2.1.0-rc.1",
    });
    const manifest = parse(output);

    assert.equal(manifest.version, "2.1.0-rc.1");
    assert.equal(manifest.files[0].url, "2.1.0-rc.1/DSH-Desktop-Setup-2.1.0-rc.1.exe");
    assert.equal(manifest.files[0].size, (await readFile(installerPath)).byteLength);
    assert.equal(manifest.path, "2.1.0-rc.1/DSH-Desktop-Setup-2.1.0-rc.1.exe");
    assert.equal(manifest.sha512, manifest.files[0].sha512);
    assert.match(manifest.releaseDate, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("generateDesktopUpdateManifestFromFile applies a GH release base URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-manifest-"));
  const base = "https://github.com/anywhere-labs/deepseek-harness-desktop/releases/download/v2.1.0";
  try {
    const installerPath = join(dir, "DSH-Desktop-Setup-2.1.0.exe");
    await writeFile(installerPath, "fake installer content");

    const output = await generateDesktopUpdateManifestFromFile({
      filePath: installerPath,
      version: "2.1.0",
      baseUrl: base,
    });
    const manifest = parse(output);

    assert.equal(manifest.files[0].url, `${base}/DSH-Desktop-Setup-2.1.0.exe`);
    assert.equal(manifest.path, `${base}/DSH-Desktop-Setup-2.1.0.exe`);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
