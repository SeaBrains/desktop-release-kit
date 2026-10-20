import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { hashFile } from "./oss-upload.mjs";
import { uploadRelease, promoteRelease } from "./publish-oss-release.mjs";

async function fixture(t, version = "1.2.3") {
  const root = await mkdtemp(join(tmpdir(), "oss-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new Map(),
    writes = [],
    requests = [];
  const options = {
    version,
    prefix: "app-cn",
    bucket: "test-bucket",
    downloadsBase: "https://cn.example",
    manifestsDir: root,
  };
  const upload = async (object) => {
    const bytes = await readFile(object.file);
    objects.set(object.key, { bytes, ...(await hashFile(object.file)) });
    writes.push(object.key);
  };
  const fetch = async (url, init) => {
    requests.push(url);
    assert.ok(url.startsWith("https://cn.example/"));
    const object = objects.get(
      decodeURIComponent(new URL(url).pathname.slice(1)),
    );
    return new Response(init?.method === "HEAD" ? null : object?.bytes, {
      status: object ? 200 : 404,
      headers: object
        ? {
            "content-length": String(object.size),
            "x-oss-meta-sha512": object.sha512,
          }
        : {},
    });
  };
  const services = { upload, fetch, log: () => {} };
  const platforms = [];
  for (const [platform, folder, ext, name] of [
    ["macos", "mac", "zip", "latest-mac.yml"],
    ["windows", "win", "exe", "latest.yml"],
  ]) {
    const dir = join(root, folder);
    await mkdir(dir);
    const file = join(dir, `app-${version}.${ext}`);
    await writeFile(file, `signed-${ext}`);
    const entry = { url: `app-${version}.${ext}`, ...(await hashFile(file)) };
    if (platform === "macos") {
      await writeFile(join(dir, `app-${version}.dmg`), "signed-dmg");
      await writeFile(`${file}.blockmap`, "blockmap");
    }
    const manifest = join(dir, name);
    await writeFile(
      manifest,
      stringify({
        version,
        files: [entry],
        path: entry.url,
        sha512: entry.sha512,
      }),
    );
    platforms.push({ ...options, platform, artifactsDir: dir, manifest });
  }
  return { options, platforms, services, objects, writes, requests };
}

test("本地签名产物直接发布到国内，双平台完成后才推进清单", async (t) => {
  const f = await fixture(t);
  for (const platform of f.platforms) await uploadRelease(platform, f.services);
  assert.equal(f.writes.length, 4);
  assert.ok(f.writes.every((key) => key.startsWith("app-cn/1.2.3/")));
  await promoteRelease(f.options, f.services);
  assert.deepEqual(f.writes.slice(4), [
    "app-cn/latest-mac.yml",
    "app-cn/latest.yml",
    "app-cn/desktop-version.json",
  ]);
  const mac = parse(f.objects.get("app-cn/latest-mac.yml").bytes.toString());
  assert.ok(mac.files.some((file) => file.url === "1.2.3/app-1.2.3.dmg"));
  assert.equal(
    JSON.parse(f.objects.get("app-cn/desktop-version.json").bytes).version,
    "1.2.3",
  );
});

test("RC 只更新本地区的 RC 清单", async (t) => {
  const f = await fixture(t, "1.2.4-rc.1");
  for (const platform of f.platforms) await uploadRelease(platform, f.services);
  await promoteRelease(f.options, f.services);
  assert.deepEqual(f.writes.slice(4), ["app-cn/rc-mac.yml", "app-cn/rc.yml"]);
});

test("本地签名字节与清单不匹配时不上传任何对象", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.platforms[0].artifactsDir, "app-1.2.3.zip"),
    "tampered",
  );
  await assert.rejects(
    uploadRelease(f.platforms[0], f.services),
    /checksum mismatch/,
  );
  assert.deepEqual(f.writes, []);
});

for (const reason of [
  "missing-platform",
  "missing-object",
  "wrong-hash",
  "rollback",
  "wrong-receipt",
]) {
  test(`${reason} 阻止所有更新指针发布`, async (t) => {
    const f = await fixture(t);
    for (const platform of f.platforms)
      await uploadRelease(platform, f.services);
    if (reason === "missing-platform")
      await rm(join(f.options.manifestsDir, "win", "oss-receipt.json"));
    if (reason === "missing-object")
      f.objects.delete("app-cn/1.2.3/app-1.2.3.exe");
    if (reason === "wrong-hash")
      f.objects.get("app-cn/1.2.3/app-1.2.3.exe").sha512 = "wrong";
    if (reason === "rollback")
      f.objects.set("app-cn/latest.yml", {
        bytes: Buffer.from("version: 9.0.0"),
        size: 14,
        sha512: "unused",
      });
    if (reason === "wrong-receipt")
      await writeFile(
        join(f.options.manifestsDir, "win", "oss-receipt.json"),
        JSON.stringify({ version: "2.0.0" }),
      );
    await assert.rejects(promoteRelease(f.options, f.services));
    assert.equal(f.writes.length, 4);
  });
}
