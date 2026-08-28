#!/usr/bin/env node
// Minimal S3/RustFS uploader (AWS SigV4) using only Node's stdlib — no aws-cli
// or SDK, so it runs on a bare self-hosted runner that only has Node. Sibling
// of s3-get.mjs; the RustFS-based signing payload transfer uses this pair.
// The file is read fully into memory: SigV4 signs a sha256 of the entire
// payload, so the body has to be materialized to hash it. Installers are
// small relative to runner memory, so a single readFile is fine here.
//
// Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
// Args:
//   --file <path>       local file to upload
//   --bucket <name>     S3 bucket
//   --key <key>         object key (path inside bucket)
//   --endpoint <url>    S3 endpoint (e.g. https://rustfs.dev.seawork.ai)
//   [--region auto]     signing region (RustFS accepts any consistent value)

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

function parseArgs(argv) {
  const out = { region: "auto" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file") {
      out.file = argv[(i += 1)];
    } else if (a === "--bucket") {
      out.bucket = argv[(i += 1)];
    } else if (a === "--key") {
      out.key = argv[(i += 1)];
    } else if (a === "--endpoint") {
      out.endpoint = argv[(i += 1)];
    } else if (a === "--region") {
      out.region = argv[(i += 1)];
    }
  }
  for (const k of ["file", "bucket", "key", "endpoint"]) {
    if (!out[k]) {
      throw new Error(`--${k} is required`);
    }
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) {
    throw new Error("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars are required");
  }

  const body = await readFile(args.file);
  const url = new URL(`${args.endpoint.replace(/\/$/, "")}/${args.bucket}/${encodeKey(args.key)}`);
  const host = url.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const service = "s3";

  const signedHeaderValues = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(signedHeaderValues).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${signedHeaderValues[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${args.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join("\n");

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "content-length": String(body.length),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 PUT failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  console.log(`[s3] uploaded ${args.key} (${body.length} bytes)`);
}

main().catch((err) => {
  console.error(`::error ::${err.message}`);
  process.exit(1);
});
