import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashFile, runOssutil, uploadObject } from "./oss-upload.mjs";

async function fixture(
  t,
  { failPart = false, corruptReadback = false, existing = false } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "oss-upload-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "signed.zip");
  const bytes = Buffer.alloc(900_000, 0x5a);
  await writeFile(file, bytes);
  let stored = existing ? bytes : undefined,
    active = 0,
    peak = 0;
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => {
    releaseFirstWave = resolve;
  });
  const calls = [],
    parts = new Map(),
    events = [];
  const execute = async (args) => {
    const op = args[1];
    calls.push(op);
    const value = (name) => args[args.indexOf(name) + 1];
    if (op === "initiate-multipart-upload") {
      assert.ok(args.includes("--forbid-overwrite=true"));
      return { Body: { UploadId: "test-upload" } };
    }
    if (op === "upload-part") {
      active++;
      peak = Math.max(peak, active);
      try {
        const number = Number(value("--part-number"));
        if (number <= 3) {
          if (active === 3) releaseFirstWave();
          await firstWave;
        }
        if (failPart && number === 2) throw new Error("part failed");
        const body = await readFile(value("--body").slice(7));
        parts.set(number, body);
        return {
          Header: { Etag: [createHash("md5").update(body).digest("hex")] },
        };
      } finally {
        active--;
      }
    }
    if (op === "complete-multipart-upload") {
      assert.equal(active, 0);
      assert.ok(args.includes("--forbid-overwrite=true"));
      const body = JSON.parse(
        await readFile(value("--complete-multipart-upload").slice(7), "utf8"),
      );
      assert.deepEqual(
        body.Part.map((p) => p.PartNumber),
        [...parts.keys()].sort((a, b) => a - b),
      );
      stored = Buffer.concat(body.Part.map((p) => parts.get(p.PartNumber)));
      assert.deepEqual(stored, bytes);
    }
    if (op === "abort-multipart-upload") assert.equal(active, 0);
    return {};
  };
  const fetch = async (_url, init) =>
    new Response(
      init?.method === "HEAD" ? null : corruptReadback ? "corrupt" : stored,
      { status: stored ? 200 : 404 },
    );
  return {
    file,
    bytes,
    calls,
    events,
    peak: () => peak,
    services: { execute, fetch, log: (...args) => events.push(args) },
    options: {
      bucket: "test-bucket",
      region: "cn-shanghai",
      downloadsBase: "https://cn.example",
      partSize: 128 * 1024,
      parallel: 3,
    },
  };
}

test("分片并发传输、按序合并并完整读回签名字节", async (t) => {
  const f = await fixture(t);
  const result = await uploadObject(
    { file: f.file, key: "app/1.0.0/app.zip", immutable: true },
    f.options,
    f.services,
  );
  assert.equal(result.size, f.bytes.length);
  assert.equal(f.peak(), 3);
  assert.equal(f.calls.filter((op) => op === "upload-part").length, 7);
  assert.equal(f.calls.includes("put-object"), false);
  assert.equal(f.events.filter((e) => e[0] === "upload:progress").length, 7);
  assert.ok(f.events.some((e) => e[0] === "verify:done"));
});

test("分片失败会等待在途请求退出并终止上传，不生成完整对象", async (t) => {
  const f = await fixture(t, { failPart: true });
  await assert.rejects(
    uploadObject(
      { file: f.file, key: "app/1.0.0/app.zip", immutable: true },
      f.options,
      f.services,
    ),
    /part failed/,
  );
  assert.equal(f.calls.includes("complete-multipart-upload"), false);
  assert.equal(f.calls.at(-1), "abort-multipart-upload");
});

test("只有同字节对象可复用，已有对象不被覆盖", async (t) => {
  const f = await fixture(t, { existing: true });
  await uploadObject(
    { file: f.file, key: "app/1.0.0/app.zip", immutable: true },
    f.options,
    f.services,
  );
  assert.deepEqual(f.calls, []);
  await writeFile(f.file, "changed signed bytes");
  await assert.rejects(
    uploadObject(
      { file: f.file, key: "app/1.0.0/app.zip", immutable: true },
      f.options,
      f.services,
    ),
    /checksum mismatch/,
  );
  assert.deepEqual(f.calls, []);
});

test("完成上传但读回损坏不能报告成功", async (t) => {
  const f = await fixture(t, { corruptReadback: true });
  await assert.rejects(
    uploadObject(
      { file: f.file, key: "app/1.0.0/app.zip", immutable: true },
      f.options,
      f.services,
    ),
    /checksum mismatch/,
  );
  assert.equal(f.events.filter((e) => e[0] === "verify:start").length, 1);
});

test("卡住的 ossutil 进程在期限内终止", async (t) => {
  const f = await fixture(t);
  const command = join(f.file, "..", "hang");
  await writeFile(
    command,
    `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const start = Date.now();
  await assert.rejects(
    runOssutil(["api", "upload-part"], { executable: command, timeoutMs: 100 }),
    /exceeded/,
  );
  assert.ok(Date.now() - start < 5000);
});
