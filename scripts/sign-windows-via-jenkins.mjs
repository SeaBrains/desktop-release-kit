#!/usr/bin/env node
// Sign a Windows installer through an internal Jenkins "SeaArt-Sign-Package"
// job. The Jenkins job holds the code-signing private key (vsigntool reads a
// local config.xml on its Windows agent), so we never handle the key here — we
// upload the unsigned exe, poll the build, and download the signed exe back.
//
// Flow: crumb -> buildWithParameters (multipart upload) -> queue item ->
// build number -> poll result -> download archived artifact.
//
// Required env:
//   JENKINS_URL   full job URL
//   JENKINS_USER  Jenkins username
//   JENKINS_TOKEN Jenkins API token (or password)
// Args:
//   --exe <path>   unsigned installer to sign (overwritten in place with signed)
//   [--method 3]   SIGN_METHOD choice (default 3, matches job default)
//   [--remark seaart]  SIGN_REMARK (default seaart)
//   [--timeout 900]    max seconds to wait for the signed artifact (default 900)

import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BUILD_POLL_MS = 5000;
const QUEUE_POLL_MS = 3000;

function parseArgs(argv) {
  const out = { method: "3", remark: "seaart", timeout: 900 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--exe") out.exe = argv[(i += 1)];
    else if (a === "--method") out.method = argv[(i += 1)];
    else if (a === "--remark") out.remark = argv[(i += 1)];
    else if (a === "--timeout") out.timeout = Number(argv[(i += 1)]);
  }
  if (!out.exe) throw new Error("--exe <path> is required");
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

function authHeader(user, token) {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function getCrumb(base, auth) {
  const res = await fetch(`${base}/crumbIssuer/api/json`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error(`crumb fetch failed: HTTP ${res.status}`);
  const { crumb, crumbRequestField } = await res.json();
  // Jenkins ties the crumb to the HTTP session — the POST that spends the crumb
  // must carry the same JSESSIONID cookie the crumb was issued under, or it 403s
  // with "No valid crumb was included in the request". Keep only the name=value
  // pair before the first ";" of each Set-Cookie.
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  return { field: crumbRequestField, value: crumb, cookie };
}

async function triggerBuild({ jobUrl, auth, crumb, exePath, filename, method, remark }) {
  const bytes = await readFile(exePath);
  const form = new FormData();
  form.append("EXE_FILE", new Blob([bytes]), filename);
  form.append("EXE_FILENAME", filename);
  form.append("SIGN_METHOD", method);
  form.append("SIGN_REMARK", remark);

  const headers = { Authorization: auth, [crumb.field]: crumb.value };
  if (crumb.cookie) headers.Cookie = crumb.cookie;
  const res = await fetch(`${jobUrl}/buildWithParameters`, {
    method: "POST",
    headers,
    body: form,
  });
  if (res.status !== 201) {
    const body = await res.text().catch(() => "");
    throw new Error(`buildWithParameters failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const queueUrl = res.headers.get("location");
  if (!queueUrl) throw new Error("no queue Location header returned");
  return queueUrl.replace(/\/$/, "");
}

async function resolveBuildUrl({ queueUrl, auth, deadline }) {
  while (Date.now() < deadline) {
    const res = await fetch(`${queueUrl}/api/json`, { headers: { Authorization: auth } });
    if (res.ok) {
      const data = await res.json();
      if (data.cancelled) throw new Error("Jenkins queue item was cancelled");
      if (data.executable?.url) return data.executable.url.replace(/\/$/, "");
    }
    await sleep(QUEUE_POLL_MS);
  }
  throw new Error("timed out waiting for queue item to start a build");
}

async function waitForBuild({ buildUrl, auth, deadline }) {
  while (Date.now() < deadline) {
    const res = await fetch(`${buildUrl}/api/json?tree=result,building`, {
      headers: { Authorization: auth },
    });
    if (res.ok) {
      const { result, building } = await res.json();
      if (!building && result) {
        if (result !== "SUCCESS") throw new Error(`Jenkins build result: ${result}`);
        return;
      }
    }
    await sleep(BUILD_POLL_MS);
  }
  throw new Error("timed out waiting for Jenkins build to finish");
}

async function downloadSignedArtifact({ buildUrl, auth, filename, exePath }) {
  const res = await fetch(`${buildUrl}/artifact/${encodeURIComponent(filename)}`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error(`artifact download failed: HTTP ${res.status}`);
  const before = (await stat(exePath)).size;
  // Stream to disk — buffering the whole installer (100+ MB) via arrayBuffer()
  // makes undici drop the connection with "terminated" on this link.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(exePath));
  return { before, after: (await stat(exePath)).size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobUrl = requireEnv("JENKINS_URL").replace(/\/$/, "");
  const base = jobUrl.replace(/\/job\/.*$/, "");
  const auth = authHeader(requireEnv("JENKINS_USER"), requireEnv("JENKINS_TOKEN"));
  const filename = basename(args.exe);
  const deadline = Date.now() + args.timeout * 1000;

  console.log(`[sign] uploading ${filename} to Jenkins for signing`);
  const crumb = await getCrumb(base, auth);
  const queueUrl = await triggerBuild({
    jobUrl,
    auth,
    crumb,
    exePath: args.exe,
    filename,
    method: args.method,
    remark: args.remark,
  });
  console.log(`[sign] queued: ${queueUrl}`);

  const buildUrl = await resolveBuildUrl({ queueUrl, auth, deadline });
  console.log(`[sign] build started: ${buildUrl}`);

  await waitForBuild({ buildUrl, auth, deadline });
  console.log("[sign] build SUCCESS, downloading signed exe");

  const { before, after } = await downloadSignedArtifact({
    buildUrl,
    auth,
    filename,
    exePath: args.exe,
  });
  console.log(`[sign] signed exe written: ${before} -> ${after} bytes`);
}

main().catch((err) => {
  console.error(`::error ::${err.message}`);
  process.exit(1);
});
