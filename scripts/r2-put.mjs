#!/usr/bin/env node
// Minimal S3/R2 uploader (AWS SigV4) using only Node's stdlib — no aws-cli or
// SDK, so it runs on a bare self-hosted runner that only has Node. The file is
// read fully into memory: SigV4 signs a sha256 of the entire payload, so the
// body has to be materialized to hash it.
//
// Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
// Args:
//   --file <path>       local file to upload
//   --bucket <name>     R2 bucket
//   --key <key>         object key (path inside bucket)
//   --endpoint <url>    R2 S3 endpoint (https://<acct>.r2.cloudflarestorage.com)
//   [--region auto]     signing region (R2 uses "auto")
//   [--immutable]       send If-None-Match: * (same-content 412 is skipped;
//                       different-content 412 is rejected)

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

function parseArgs(argv) {
  const out = { region: "auto", immutable: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file") out.file = argv[(i += 1)];
    else if (a === "--bucket") out.bucket = argv[(i += 1)];
    else if (a === "--key") out.key = argv[(i += 1)];
    else if (a === "--endpoint") out.endpoint = argv[(i += 1)];
    else if (a === "--region") out.region = argv[(i += 1)];
    else if (a === "--immutable") out.immutable = true;
  }
  for (const k of ["file", "bucket", "key", "endpoint"]) {
    if (!out[k]) throw new Error(`--${k} is required`);
  }
  return out;
}

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// Encode each path segment but keep the slashes between them.
function encodeKey(key) {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function signedFetch({ method, url, accessKey, secretKey, region, extraSigned = {}, extraHeaders = {}, body, payloadHash }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";
  const signedHeaderValues = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraSigned,
  };
  const signedHeaderNames = Object.keys(signedHeaderValues).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${signedHeaderValues[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const headers = {
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };

  return fetch(url, { method, headers, body });
}

async function getExistingBody({ url, accessKey, secretKey, region }) {
  const payloadHash = sha256Hex(Buffer.alloc(0));
  const res = await signedFetch({
    method: "GET",
    url,
    accessKey,
    secretKey,
    region,
    payloadHash,
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) {
    throw new Error("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars are required");
  }

  const body = await readFile(args.file);
  const url = new URL(`${args.endpoint.replace(/\/$/, "")}/${args.bucket}/${encodeKey(args.key)}`);
  const payloadHash = sha256Hex(body);
  const extraSigned = {};
  const extraHeaders = { "content-length": String(body.length) };
  if (args.immutable) {
    extraSigned["if-none-match"] = "*";
    extraHeaders["If-None-Match"] = "*";
  }

  const res = await signedFetch({
    method: "PUT",
    url,
    accessKey,
    secretKey,
    region: args.region,
    extraSigned,
    extraHeaders,
    body,
    payloadHash,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (args.immutable && res.status === 412) {
      const existing = await getExistingBody({
        url,
        accessKey,
        secretKey,
        region: args.region,
      });
      if (existing && sha256Hex(existing) === payloadHash) {
        console.warn(`[r2] ${args.key} already exists with identical content, skipping`);
        return;
      }
      throw new Error(`R2 PUT rejected (If-None-Match): ${args.key} already exists`);
    }
    throw new Error(`R2 PUT failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  console.log(`[r2] uploaded ${args.key} (${body.length} bytes)`);
}

main().catch((err) => {
  console.error(`::error ::${err.message}`);
  process.exit(1);
});
