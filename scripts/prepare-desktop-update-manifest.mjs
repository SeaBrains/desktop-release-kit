#!/usr/bin/env node
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { parseReleaseVersion } from "./release-version-utils.mjs";

function usageAndExit(code = 1) {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/prepare-desktop-update-manifest.mjs --manifest <path> --version <version> [--base-url <url>]",
      "  node scripts/prepare-desktop-update-manifest.mjs --generate-from-file <path> --manifest <path> --version <version> [--base-url <url>]",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  let manifestPath = "";
  let version = "";
  let generateFromFilePath = "";
  let baseUrl = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      manifestPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--version") {
      version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--generate-from-file") {
      generateFromFilePath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      baseUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!manifestPath || !version) {
    usageAndExit();
  }

  return { generateFromFilePath, manifestPath, version, baseUrl };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifestString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Desktop update manifest must contain a non-empty ${label}.`);
  }
  return value.trim();
}

function validateReleaseVersion(version) {
  return parseReleaseVersion(readManifestString(version, "version")).version;
}

function isAbsoluteUpdateUrl(value) {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("/");
}

export function prefixDesktopUpdatePath(value, version, baseUrl = "") {
  const releaseVersion = validateReleaseVersion(version);
  const updatePath = readManifestString(value, "download path").replace(/^\.\//, "");
  if (baseUrl) {
    // GH Release / custom CDN base: prefix unconditionally (electron-builder writes
    // relative asset filenames when --publish never).
    return `${baseUrl.replace(/\/$/, "")}/${updatePath}`;
  }
  // Fallback to the R2-style version-scoped directory (paseo layout).
  if (isAbsoluteUpdateUrl(updatePath) || updatePath.startsWith(`${releaseVersion}/`)) {
    return updatePath;
  }
  return `${releaseVersion}/${updatePath}`;
}

export function prepareDesktopUpdateManifest(source, options) {
  const version = validateReleaseVersion(options?.version);
  const baseUrl = options?.baseUrl ?? "";
  const manifest = parse(source);
  if (!isRecord(manifest)) {
    throw new Error("Desktop update manifest must be a YAML object.");
  }

  const manifestVersion = readManifestString(manifest.version, "version");
  if (manifestVersion !== version) {
    throw new Error(
      `Desktop update manifest version ${manifestVersion} does not match release version ${version}.`,
    );
  }

  let updatePathCount = 0;
  const files = manifest.files;
  if (Array.isArray(files)) {
    for (const file of files) {
      if (!isRecord(file) || typeof file.url !== "string") {
        continue;
      }
      file.url = prefixDesktopUpdatePath(file.url, version, baseUrl);
      updatePathCount += 1;
    }
  }

  if (typeof manifest.path === "string") {
    manifest.path = prefixDesktopUpdatePath(manifest.path, version, baseUrl);
    updatePathCount += 1;
  }

  const packages = manifest.packages;
  if (isRecord(packages)) {
    for (const packageInfo of Object.values(packages)) {
      if (!isRecord(packageInfo) || typeof packageInfo.path !== "string") {
        continue;
      }
      packageInfo.path = prefixDesktopUpdatePath(packageInfo.path, version, baseUrl);
      updatePathCount += 1;
    }
  }

  if (updatePathCount === 0) {
    throw new Error("Desktop update manifest did not contain any file URLs to rewrite.");
  }

  return stringify(manifest);
}

export async function generateDesktopUpdateManifestFromFile(options) {
  const version = validateReleaseVersion(options?.version);
  const baseUrl = options?.baseUrl ?? "";
  const filePath = readManifestString(options?.filePath, "file path");
  const fileName = basename(filePath);
  const [buffer, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
  const sha512 = createHash("sha512").update(buffer).digest("base64");

  return stringify({
    version,
    files: [
      {
        url: prefixDesktopUpdatePath(fileName, version, baseUrl),
        sha512,
        size: stats.size,
      },
    ],
    path: prefixDesktopUpdatePath(fileName, version, baseUrl),
    sha512,
    releaseDate: new Date().toISOString(),
  });
}

export async function prepareDesktopUpdateManifestFile(options) {
  if (options.generateFromFilePath) {
    const output = await generateDesktopUpdateManifestFromFile({
      filePath: options.generateFromFilePath,
      version: options.version,
      baseUrl: options.baseUrl,
    });
    await writeFile(options.manifestPath, output);
    return;
  }

  const source = await readFile(options.manifestPath, "utf-8");
  const output = prepareDesktopUpdateManifest(source, {
    version: options.version,
    baseUrl: options.baseUrl,
  });
  await writeFile(options.manifestPath, output);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  prepareDesktopUpdateManifestFile(args).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
