#!/usr/bin/env node
// Minimal S3/RustFS downloader (AWS SigV4) using only Node's stdlib — no
// aws-cli or SDK, so it runs on a bare self-hosted runner that only has Node.
// Streams the body to disk instead of buffering, so multi-hundred-MB
// installers stay off the heap.
//
// Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
// Args:
//   --bucket <name>     bucket name
//   --key <key>         object key (path inside bucket)
//   --endpoint <url>    S3 endpoint (e.g. https://rustfs.dev.seawork.ai)
//   --output <path>     local file to write the object into
//   [--region auto]     signing region (RustFS accepts any consistent value)

import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

function parseArgs(argv) {
  const out = { region: "auto" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--bucket") {
      out.bucket = argv[(i += 1)];
    } else if (a === "--key") {
      out.key = argv[(i += 1)];
    } else if (a === "--endpoint") {
      out.endpoint = argv[(i += 1)];
    } else if (a === "--output") {
      out.output = argv[(i += 1)];
    } else if (a === "--region") {
      out.region = argv[(i += 1)];
    }
  }
  for (const k of ["bucket", "key", "endpoint", "output"]) {
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

  const url = new URL(`${args.endpoint.replace(/\/$/, "")}/${args.bucket}/${encodeKey(args.key)}`);
  const host = url.host;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(Buffer.alloc(0));
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
    "GET",
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
    method: "GET",
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 GET failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(args.output));
  console.log(`[s3] downloaded ${args.key} -> ${args.output}`);
}

main().catch((err) => {
  console.error(`::error ::${err.message}`);
  process.exit(1);
});
