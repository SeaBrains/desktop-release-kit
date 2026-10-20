import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

export function logStage(stage, key, details = {}) {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), stage, key, ...details }),
  );
}

export async function hashFile(file) {
  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha512: hash.digest("base64") };
}

export function runOssutil(
  args,
  { executable = "ossutil", timeoutMs = 180_000, signal } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolveCommand, reject) => {
    const child = spawn(
      executable,
      [
        ...args,
        "--output-format",
        "json",
        "--retry-times",
        "3",
        "--connect-timeout",
        "10",
        "--read-timeout",
        "60",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "",
      timedOut = false,
      forceKill;
    const stop = () => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 3000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const abort = () => {
      if (!forceKill) stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (timedOut)
        return reject(
          new Error(`ossutil ${args[1]} exceeded ${timeoutMs / 1000}s`),
        );
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) {
        let message = stderr || stdout.slice(-2000);
        for (const name of [
          "OSS_ACCESS_KEY_ID",
          "OSS_ACCESS_KEY_SECRET",
          "OSS_SESSION_TOKEN",
        ]) {
          if (process.env[name])
            message = message.replaceAll(process.env[name], "[redacted]");
        }
        return reject(
          new Error(`ossutil ${args[1]} failed (${code}): ${message}`),
        );
      }
      const start = stdout.indexOf("{");
      try {
        resolveCommand(
          start < 0
            ? {}
            : JSON.parse(stdout.slice(start, stdout.lastIndexOf("}") + 1)),
        );
      } catch {
        reject(new Error(`Invalid JSON response from ossutil ${args[1]}`));
      }
    });
  });
}

function field(result, name) {
  if (!result || typeof result !== "object") return undefined;
  for (const [key, value] of Object.entries(result)) {
    if (key.toLowerCase() === name.toLowerCase())
      return Array.isArray(value) ? value[0] : value;
  }
  for (const value of Object.values(result)) {
    const found = field(value, name);
    if (found !== undefined) return found;
  }
}

export function objectUrl(base, key) {
  return `${base.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export async function verifyObject(
  url,
  expected,
  { fetcher = fetch, log = logStage, timeoutMs = 600_000, signal } = {},
) {
  log("verify:start", url, { bytes: expected.size });
  const start = Date.now();
  const response = await fetcher(url, {
    cache: "no-store",
    signal: AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]),
  });
  if (
    !response.ok ||
    /text\/html|application\/xhtml/i.test(
      response.headers.get("content-type") || "",
    )
  )
    throw new Error(`Invalid OSS read-back: HTTP ${response.status} ${url}`);
  const hash = createHash("sha512");
  let bytes = 0,
    lastLog = start;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
    if (Date.now() - lastLog >= 5000) {
      log("verify:progress", url, { bytes, total: expected.size });
      lastLog = Date.now();
    }
  }
  if (bytes !== expected.size || hash.digest("base64") !== expected.sha512)
    throw new Error(`OSS read-back checksum mismatch: ${url}`);
  log("verify:done", url, { bytes, seconds: (Date.now() - start) / 1000 });
}

export async function uploadObject(object, options, services = {}) {
  const log = services.log || logStage;
  const execute = services.execute || runOssutil;
  const fetcher = services.fetch || fetch;
  const key = object.key;
  if (
    !/^[a-z0-9][a-z0-9/_-]*$/i.test(options.bucket) ||
    key
      .split("/")
      .some((p) => !p || p === "." || p === ".." || /[\\\r\n]/.test(p))
  )
    throw new Error("Invalid OSS bucket/key");
  const expected = object.digest || (await hashFile(object.file));
  if (!expected.size) throw new Error(`Refusing empty object: ${key}`);
  const url = objectUrl(options.downloadsBase, key);
  const timeoutMs = options.timeoutMs || 600_000;
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const common = [
    "--bucket",
    options.bucket,
    "--key",
    key,
    "--region",
    options.region || "cn-shanghai",
    "--endpoint",
    `https://oss-${options.region || "cn-shanghai"}.aliyuncs.com`,
  ];
  const call = (operation, args, cleanup = false) =>
    execute(["api", operation, ...common, ...args], {
      executable: options.ossutil || "ossutil",
      timeoutMs: cleanup ? 30_000 : 180_000,
      ...(cleanup ? {} : { signal }),
    });
  const verify = () =>
    verifyObject(url, expected, {
      fetcher,
      log,
      timeoutMs,
      signal: options.signal,
    });
  if (object.immutable) {
    const existing = await fetcher(url, { method: "HEAD", signal });
    if (existing.ok) {
      await verify();
      log("upload:reuse", key);
      return { key, ...expected };
    }
    if (existing.status !== 404)
      throw new Error(`Cannot inspect OSS object: HTTP ${existing.status}`);
  }
  const metadata = [
    "--metadata",
    `sha512=${expected.sha512}`,
    "--content-type",
    object.contentType || "application/octet-stream",
    "--cache-control",
    object.immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache, max-age=0, must-revalidate",
  ];
  const partSize = options.partSize || 8 * 1024 * 1024;
  const parallel = options.parallel || 4;
  if (
    !Number.isInteger(partSize) ||
    partSize < 100 * 1024 ||
    !Number.isInteger(parallel) ||
    parallel < 1 ||
    parallel > 16
  )
    throw new Error("Invalid multipart settings");
  const started = Date.now();
  log("upload:start", key, { bytes: expected.size, partSize, parallel });
  let uploadId,
    stored = false;
  const directory = await mkdtemp(join(tmpdir(), "oss-parts-"));
  try {
    if (expected.size <= partSize) {
      await call("put-object", [
        "--body",
        `file://${resolve(object.file)}`,
        ...metadata,
        ...(object.immutable ? ["--forbid-overwrite=true"] : []),
      ]);
    } else {
      uploadId = field(
        await call("initiate-multipart-upload", [
          ...metadata,
          ...(object.immutable ? ["--forbid-overwrite=true"] : []),
        ]),
        "UploadId",
      );
      if (typeof uploadId !== "string" || !uploadId)
        throw new Error("OSS did not return an upload ID");
      const count = Math.ceil(expected.size / partSize);
      if (count > 10000) throw new Error("Too many multipart parts");
      const parts = new Array(count);
      let next = 0,
        completed = 0,
        failure;
      const workers = Array.from(
        { length: Math.min(parallel, count) },
        async () => {
          while (!failure && next < count) {
            const index = next++;
            const start = index * partSize;
            const end = Math.min(expected.size, start + partSize) - 1;
            const file = join(directory, `part-${index + 1}`);
            try {
              signal.throwIfAborted();
              await pipeline(
                createReadStream(object.file, { start, end }),
                createWriteStream(file),
                { signal },
              );
              const result = await call("upload-part", [
                "--upload-id",
                uploadId,
                "--part-number",
                String(index + 1),
                "--body",
                `file://${file}`,
              ]);
              const etag = field(result, "ETag");
              if (typeof etag !== "string" || !etag)
                throw new Error(`Missing ETag for part ${index + 1}`);
              parts[index] = { PartNumber: index + 1, ETag: etag };
              completed += end - start + 1;
              log("upload:progress", key, {
                part: index + 1,
                parts: count,
                bytes: completed,
                total: expected.size,
                seconds: (Date.now() - started) / 1000,
              });
            } catch (error) {
              failure ||= error;
            } finally {
              await rm(file, { force: true });
            }
          }
        },
      );
      await Promise.all(workers);
      if (failure) throw failure;
      const completion = join(directory, "complete.json");
      await writeFile(completion, JSON.stringify({ Part: parts }));
      await call("complete-multipart-upload", [
        "--upload-id",
        uploadId,
        "--complete-multipart-upload",
        `file://${completion}`,
        ...(object.immutable ? ["--forbid-overwrite=true"] : []),
      ]);
      uploadId = undefined;
    }
    stored = true;
    log("upload:done", key, {
      bytes: expected.size,
      seconds: (Date.now() - started) / 1000,
    });
    await verify();
    return { key, ...expected };
  } catch (error) {
    if (uploadId) {
      try {
        await call("abort-multipart-upload", ["--upload-id", uploadId], true);
        log("upload:aborted", key);
      } catch {
        log("upload:abort-failed", key);
      }
    }
    // 同名文件可能由另一个发布者先完成；只有相同字节才能复用。
    if (object.immutable && !stored && !options.signal?.aborted) {
      const existing = await fetcher(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(30_000),
      });
      if (existing.ok) {
        await verify();
        log("upload:reuse-after-race", key);
        return { key, ...expected };
      }
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
