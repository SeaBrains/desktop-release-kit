import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Must be present in every Windows win-unpacked tree we ship.
// Elevated/native helpers are intentionally NOT listed here — electron-builder
// packs its own unsigned elevate.exe into resources during NSIS build,
// overwriting any pre-signed copy — signing it upstream is wasted work.
const executableName = process.env.RELEASE_EXECUTABLE_NAME?.trim() ?? "";
if (!executableName) {
  throw new Error("RELEASE_EXECUTABLE_NAME env var is required");
}
if (executableName.includes("/") || executableName.includes("\\") || executableName.includes("..")) {
  throw new Error("RELEASE_EXECUTABLE_NAME must be a file name like App.exe");
}

const requiredRelativePaths = [executableName];

// Present only for some electron-builder layouts / optional bundled tools.
const optionalRelativePaths = [];

const rootIndex = process.argv.indexOf("--root");
const rootArgument = rootIndex === -1 ? undefined : process.argv[rootIndex + 1];

if (!rootArgument || process.argv.length !== rootIndex + 2) {
  throw new Error("Usage: node scripts/list-windows-signing-targets.mjs --root <win-unpacked-dir>");
}

const root = resolve(rootArgument);

function resolveInsideRoot(targetRelativePath) {
  const targetPath = resolve(root, targetRelativePath);
  const relativeTargetPath = relative(root, targetPath);
  if (relativeTargetPath.startsWith("..") || isAbsolute(relativeTargetPath)) {
    throw new Error(`Signing target escapes win-unpacked root: ${targetRelativePath}`);
  }
  return targetPath;
}

for (const targetRelativePath of requiredRelativePaths) {
  const targetPath = resolveInsideRoot(targetRelativePath);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new Error(`Expected Windows signing target is missing: ${targetPath}`);
  }
  console.log(targetPath);
}

for (const targetRelativePath of optionalRelativePaths) {
  const targetPath = resolveInsideRoot(targetRelativePath);
  if (existsSync(targetPath) && statSync(targetPath).isFile()) {
    console.log(targetPath);
  }
}
