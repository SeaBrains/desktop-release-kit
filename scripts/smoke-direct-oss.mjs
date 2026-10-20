import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  hashFile,
  objectUrl,
  runOssutil,
  uploadObject,
  verifyObject,
} from "./oss-upload.mjs";
import { promoteRelease, uploadRelease } from "./publish-oss-release.mjs";

const prefix = `integration-tests/direct-oss/${process.env.GITHUB_RUN_ID || "local"}-${randomUUID()}`;
const options = {
  prefix,
  version: "0.0.1",
  bucket: "seabrains-data-download",
  region: "cn-shanghai",
  downloadsBase: "https://download.seabrains.cn",
  partSize: 1024 * 1024,
  ossutil: process.env.OSSUTIL || "ossutil",
};
const root = await mkdtemp(join(tmpdir(), "oss-smoke-"));
const keys = new Set([
  `${prefix}/latest-mac.yml`,
  `${prefix}/latest.yml`,
  `${prefix}/desktop-version.json`,
]);
let failure;
try {
  for (const [platform, folder, ext, size, name] of [
    ["macos", "mac", "zip", 3 * 1024 * 1024 + 123, "latest-mac.yml"],
    ["windows", "win", "exe", 2 * 1024 * 1024 + 57, "latest.yml"],
  ]) {
    const dir = join(root, folder);
    await mkdir(dir);
    const filename = `probe-0.0.1.${ext}`;
    const file = join(dir, filename);
    await writeFile(file, randomBytes(size));
    const artifact = { url: filename, ...(await hashFile(file)) };
    keys.add(`${prefix}/0.0.1/${filename}`);
    if (platform === "macos") {
      await writeFile(
        join(dir, "probe-0.0.1.dmg"),
        randomBytes(1024 * 1024 + 41),
      );
      await writeFile(`${file}.blockmap`, randomBytes(128 * 1024));
      keys.add(`${prefix}/0.0.1/probe-0.0.1.dmg`);
      keys.add(`${prefix}/0.0.1/${filename}.blockmap`);
    }
    const manifest = join(dir, name);
    await writeFile(
      manifest,
      stringify({
        version: "0.0.1",
        files: [artifact],
        path: filename,
        sha512: artifact.sha512,
      }),
    );
    await uploadRelease({ ...options, platform, artifactsDir: dir, manifest });
  }
  await promoteRelease({ ...options, manifestsDir: root });
  const file = join(root, "win", "probe-0.0.1.exe");
  const object = {
    file,
    key: `${prefix}/0.0.1/probe-0.0.1.exe`,
    immutable: true,
  };
  await uploadObject(object, options);
  const original = await hashFile(file);
  await writeFile(file, randomBytes(2 * 1024 * 1024 + 57));
  await assert.rejects(uploadObject(object, options), /checksum mismatch/);
  let hideExisting = true;
  await assert.rejects(
    uploadObject(object, options, {
      fetch: (url, init) => {
        if (init?.method === "HEAD" && hideExisting) {
          hideExisting = false;
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        return fetch(url, init);
      },
    }),
    /checksum mismatch/,
  );
  await verifyObject(objectUrl(options.downloadsBase, object.key), original);
  console.log(
    `Direct OSS smoke passed: ${prefix}; multipart, read-back, both pointers, reuse and overwrite rejection verified.`,
  );
} catch (error) {
  failure = error;
} finally {
  for (const key of keys) {
    try {
      await runOssutil(
        [
          "api",
          "delete-object",
          "--bucket",
          options.bucket,
          "--key",
          key,
          "--region",
          options.region,
        ],
        { executable: options.ossutil, timeoutMs: 30_000 },
      );
    } catch (error) {
      console.error(`Smoke cleanup failed: ${key}`);
      failure ||= error;
    }
  }
  await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
