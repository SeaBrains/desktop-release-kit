import assert from "node:assert/strict";
import test from "node:test";
import {
  compareReleaseVersions,
  getReleaseInfoFromSourceTag,
  normalizeReleaseTag,
} from "./release-version-utils.mjs";

test("normalizeReleaseTag accepts v and desktop-v tags", () => {
  assert.equal(normalizeReleaseTag("desktop-v2.1.0"), "v2.1.0");
  assert.equal(normalizeReleaseTag("v2.1.0-rc.1"), "v2.1.0-rc.1");
});

test("compareReleaseVersions treats a release as newer than its prerelease", () => {
  assert.ok(compareReleaseVersions("2.1.0-rc.9", "2.1.0") < 0);
  assert.ok(compareReleaseVersions("2.1.0", "2.1.0-rc.9") > 0);
  assert.equal(compareReleaseVersions("2.1.0", "2.1.0"), 0);
  assert.ok(compareReleaseVersions("2.1.0-rc.9", "2.1.0-rc.10") < 0);
  assert.ok(compareReleaseVersions("2.0.9", "2.1.0") < 0);
});

test("getReleaseInfoFromSourceTag accepts RELEASE_TAG_PREFIX", () => {
  const previous = process.env.RELEASE_TAG_PREFIX;
  process.env.RELEASE_TAG_PREFIX = "myapp-v";
  try {
    const info = getReleaseInfoFromSourceTag("myapp-v1.2.3");
    assert.equal(info.version, "1.2.3");
    assert.equal(info.releaseTag, "v1.2.3");
  } finally {
    if (previous === undefined) delete process.env.RELEASE_TAG_PREFIX;
    else process.env.RELEASE_TAG_PREFIX = previous;
  }
});
