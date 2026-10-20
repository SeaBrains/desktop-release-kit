import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import {
  mirrorRelease,
  planManifest,
  releaseVersion,
} from "./mirror-release-to-oss.mjs";

const version = "1.2.3";
const checksum = (bytes) => createHash("sha512").update(bytes).digest("base64");
const installer = Buffer.from("MZ-signed-windows-installer");
const archive = Buffer.from("PK-signed-mac-archive");
function manifest(file, bytes) {
  return stringify({
    version,
    files: [
      {
        url: `${version}/${file}`,
        sha512: checksum(bytes),
        size: bytes.length,
      },
    ],
    path: `${version}/${file}`,
    sha512: checksum(bytes),
  });
}

test("release identity keeps production, RC and platform tag prefixes intact", () => {
  for (const prefix of [
    "v",
    "cn-v",
    "cn-test-v",
    "test-v",
    "desktop-mac-v",
    "desktop-windows-v",
    "seagame-desktop-v",
  ]) {
    assert.equal(
      releaseVersion({ sourceTag: `${prefix}1.2.3-rc.4` }),
      "1.2.3-rc.4",
    );
  }
  assert.throws(() =>
    releaseVersion({ sourceTag: "seagame-v1.2.3-gha-smoke" }),
  );
});

test("absolute source URLs become version-relative China download URLs", () => {
  const source = manifest("Sea Work.exe", installer).replaceAll(
    "1.2.3/Sea Work.exe",
    "https://foreign.example/seagame/1.2.3/Sea Work.exe",
  );
  const result = planManifest(source, {
    version,
    sourceBase: "https://foreign.example/seagame",
  });
  assert.equal(parse(result.manifest).files[0].url, "1.2.3/Sea Work.exe");
  assert.equal(result.artifacts.length, 1);
  assert.equal(
    result.artifacts[0].sourceUrl,
    "https://foreign.example/seagame/1.2.3/Sea%20Work.exe",
  );
  assert.equal(result.artifacts[0].size, installer.length);
});

test("a mirror refuses another version, another host, traversal and missing checksums", () => {
  const source = manifest("app.exe", installer);
  const options = { version, sourceBase: "https://foreign.example/product" };
  for (const altered of [
    source.replace("version: 1.2.3", "version: 9.9.9"),
    source.replaceAll("1.2.3/app.exe", "https://other.example/1.2.3/app.exe"),
    source.replaceAll("1.2.3/app.exe", "1.2.3/%2e%2e/other.exe"),
    source.replaceAll(checksum(installer), "invalid"),
  ]) {
    assert.throws(() => planManifest(altered, options));
  }
});

async function fixture(
  t,
  { corruptSource = false, corruptTarget = false, newerPointer = false } = {},
) {
  const sources = new Map([
    ["latest.yml", manifest("app.exe", installer)],
    ["latest-mac.yml", manifest("app.zip", archive)],
    [
      `${version}/app.exe`,
      corruptSource ? Buffer.from("corrupt-installer") : installer,
    ],
    [`${version}/app.exe.blockmap`, Buffer.from("external-blockmap")],
    [`${version}/app.zip`, archive],
    ["desktop-version.json", JSON.stringify({ version })],
  ]);
  const targets = new Map();
  const uploads = [];
  if (newerPointer) targets.set("latest.yml", Buffer.from("version: 2.0.0\n"));
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url);
    const bytes = path.startsWith("/source/")
      ? sources.get(path.slice(8))
      : targets.get(path.slice("/target/seagame/test/".length));
    if (bytes === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Length", Buffer.byteLength(bytes));
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = {
    version,
    prefix: "seagame/test",
    sourceBase: `${base}/source`,
    targetBase: `${base}/target`,
    manifests: ["latest-mac.yml", "latest.yml"],
    bucket: "example",
  };
  const services = {
    upload: async (object) => {
      const bytes = await readFile(object.path);
      uploads.push(object);
      const key = object.key.slice("seagame/test/".length);
      targets.set(
        key,
        corruptTarget && object.immutable
          ? Buffer.from("bad-storage-bytes")
          : bytes,
      );
    },
  };
  return { options, services, uploads, targets };
}

test("signed DMGs supplied by the release job join only the macOS China manifest", async (t) => {
  const f = await fixture(t);
  f.options.extraArtifacts = [
    {
      url: "1.2.3/app.exe",
      sha512: checksum(installer),
      size: installer.length,
    },
  ];
  await mirrorRelease(f.options, f.services);
  assert.equal(
    parse(f.targets.get("latest-mac.yml").toString()).files.length,
    2,
  );
  assert.equal(parse(f.targets.get("latest.yml").toString()).files.length, 1);
});

test("both updater platforms and blockmaps are hash-verified before any China pointer moves", async (t) => {
  const f = await fixture(t);
  const receipt = await mirrorRelease(f.options, f.services);
  assert.equal(receipt.artifacts.length, 3);
  assert.equal(receipt.manifests.length, 3);
  const firstPointer = f.uploads.findIndex((object) => !object.immutable);
  assert.equal(firstPointer, 3);
  assert.ok(f.uploads.slice(firstPointer).every((object) => !object.immutable));
  assert.equal(
    parse(f.targets.get("latest.yml").toString()).files[0].url,
    "1.2.3/app.exe",
  );
  assert.deepEqual(f.targets.get("1.2.3/app.exe"), installer);
  const secondReceipt = await mirrorRelease(f.options, f.services);
  assert.equal(secondReceipt.artifacts.length, 3);
  assert.equal(
    f.uploads.filter((object) => object.immutable).length,
    3,
    "matching immutable artifacts are reused",
  );
});

for (const failure of ["corruptSource", "corruptTarget", "newerPointer"]) {
  test(`${failure} never publishes an update pointer`, async (t) => {
    const f = await fixture(t, { [failure]: true });
    await assert.rejects(mirrorRelease(f.options, f.services));
    assert.ok(f.uploads.every((object) => object.immutable));
  });
}

test("an immutable upload race succeeds only when the existing bytes match", async (t) => {
  const f = await fixture(t);
  const upload = f.services.upload;
  f.services.upload = async (object) => {
    await upload(object);
    if (object.immutable)
      throw new Error("Another writer won the immutable upload");
  };
  const receipt = await mirrorRelease(f.options, f.services);
  assert.equal(receipt.manifests.length, 3);
});

test("desktop-version.json cannot be rolled back independently of the platform manifests", async (t) => {
  const f = await fixture(t);
  f.targets.set("desktop-version.json", Buffer.from('{"version":"2.0.0"}'));
  await assert.rejects(mirrorRelease(f.options, f.services), /roll back/);
  assert.equal(f.uploads.length, 0);
});
