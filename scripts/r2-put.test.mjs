import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./r2-put.mjs", import.meta.url));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function runPut(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: "test-id",
        AWS_SECRET_ACCESS_KEY: "test-secret",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function putOnce({ immutable }) {
  const dir = await mkdtemp(join(tmpdir(), "r2-put-"));
  const file = join(dir, "payload.bin");
  await writeFile(file, "hello");
  let captured;
  const server = createServer((req, res) => {
    captured = { method: req.method, headers: { ...req.headers } };
    res.writeHead(200);
    res.end();
  });
  try {
    const port = await listen(server);
    const args = [
      script,
      "--file",
      file,
      "--bucket",
      "bucket",
      "--key",
      "slug/1.0.0/file.bin",
      "--endpoint",
      `http://127.0.0.1:${port}`,
    ];
    if (immutable) args.push("--immutable");
    const result = await runPut(args);
    if (result.status !== 0) {
      throw new Error(result.stderr || `exit ${result.status}`);
    }
    if (!captured) {
      throw new Error("r2-put did not issue a request");
    }
    return captured;
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
}

test("r2-put --immutable sends If-None-Match: *", async () => {
  const captured = await putOnce({ immutable: true });
  assert.equal(captured.method, "PUT");
  assert.equal(captured.headers["if-none-match"], "*");
});

test("r2-put without --immutable omits If-None-Match", async () => {
  const captured = await putOnce({ immutable: false });
  assert.equal(captured.method, "PUT");
  assert.equal(captured.headers["if-none-match"], undefined);
});

async function putImmutableWithExisting({ localBody, existingBody }) {
  const dir = await mkdtemp(join(tmpdir(), "r2-put-"));
  const file = join(dir, "payload.bin");
  await writeFile(file, localBody);
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    if (req.method === "PUT") {
      res.writeHead(412);
      res.end("Precondition Failed");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200);
      res.end(existingBody);
      return;
    }
    res.writeHead(405);
    res.end();
  });
  try {
    const port = await listen(server);
    return await runPut([
      script,
      "--file",
      file,
      "--bucket",
      "bucket",
      "--key",
      "slug/1.0.0/file.bin",
      "--endpoint",
      `http://127.0.0.1:${port}`,
      "--immutable",
    ]);
  } finally {
    await close(server);
    await rm(dir, { force: true, recursive: true });
  }
}

test("r2-put --immutable skips 412 when existing content matches", async () => {
  const result = await putImmutableWithExisting({
    localBody: "hello",
    existingBody: "hello",
  });
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /already exists with identical content, skipping/);
});

test("r2-put --immutable fails 412 when existing content differs", async () => {
  const result = await putImmutableWithExisting({
    localBody: "hello",
    existingBody: "other",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
});
