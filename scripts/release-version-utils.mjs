const versionPattern =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$/;
const defaultSourceTagPattern =
  /^(?:(?:desktop(?:-(?:windows|linux|macos))?|android)-)?v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sourceTagPattern() {
  const extra = process.env.RELEASE_TAG_PREFIX?.trim() ?? "";
  if (!extra) {
    return defaultSourceTagPattern;
  }
  return new RegExp(
    `^(?:(?:(?:desktop(?:-(?:windows|linux|macos))?|android)-)?v|${escapeRegExp(extra)})(?<version>\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`,
  );
}

function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function parseReleaseVersion(version) {
  const trimmed = version.trim();
  const match = trimmed.match(versionPattern);
  if (!match?.groups) {
    throw new Error(
      `Unsupported release version "${version}". Expected semver like 2.1.0 or 2.1.0-rc.1.`,
    );
  }

  const major = Number.parseInt(match.groups.major, 10);
  const minor = Number.parseInt(match.groups.minor, 10);
  const patch = Number.parseInt(match.groups.patch, 10);
  const prerelease = match.groups.prerelease ?? null;
  const rcMatch = prerelease?.match(/^rc\.(?<rc>\d+)$/) ?? null;
  const rcNumber = rcMatch?.groups?.rc ? Number.parseInt(rcMatch.groups.rc, 10) : null;

  assertInteger(major, "major version");
  assertInteger(minor, "minor version");
  assertInteger(patch, "patch version");
  if (rcNumber !== null) {
    assertInteger(rcNumber, "release candidate number");
  }

  return {
    version: trimmed,
    major,
    minor,
    patch,
    prerelease,
    baseVersion: `${major}.${minor}.${patch}`,
    isPrerelease: prerelease !== null,
    isReleaseCandidate: rcNumber !== null,
    rcNumber,
  };
}

function comparePrerelease(left, right) {
  const a = left.split(".");
  const b = right.split(".");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta;
      continue;
    }
    if (xNum) return -1;
    if (yNum) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareReleaseVersions(left, right) {
  const a = typeof left === "string" ? parseReleaseVersion(left) : left;
  const b = typeof right === "string" ? parseReleaseVersion(right) : right;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function formatReleaseVersion({ major, minor, patch, prerelease = null }) {
  assertInteger(major, "major version");
  assertInteger(minor, "minor version");
  assertInteger(patch, "patch version");
  return prerelease ? `${major}.${minor}.${patch}-${prerelease}` : `${major}.${minor}.${patch}`;
}

export function normalizeReleaseTag(rawTag) {
  const trimmed = rawTag.trim().replace(/^refs\/tags\//, "");
  const match = trimmed.match(sourceTagPattern());
  if (!match?.groups?.version) {
    throw new Error(
      `Unsupported release tag "${rawTag}". Expected vX.Y.Z, vX.Y.Z-rc.N, desktop-v..., or android-v...`,
    );
  }
  return `v${match.groups.version}`;
}

export function getReleaseInfoFromSourceTag(sourceTag) {
  const releaseTag = normalizeReleaseTag(sourceTag);
  const parsed = parseReleaseVersion(releaseTag.slice(1));
  return {
    sourceTag,
    releaseTag,
    version: parsed.version,
    baseVersion: parsed.baseVersion,
    prerelease: parsed.prerelease,
    isPrerelease: parsed.isPrerelease,
    isReleaseCandidate: parsed.isReleaseCandidate,
    rcNumber: parsed.rcNumber,
    releaseType: parsed.isPrerelease ? "prerelease" : "release",
  };
}
