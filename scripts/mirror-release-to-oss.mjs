#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

export function releaseVersion(options) {
  const version =
    options.version ||
    /(?:^|-)v(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(options.sourceTag ?? "")?.[1];
  if (!version || /smoke/i.test(version))
    throw new Error("An exact non-smoke release version or tag is required.");
  return parseReleaseVersion(version).version;
}

function directoryUrl(value) {
  const url = new URL(`${value.replace(/\/+$/, "")}/`);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  ) {
    throw new Error(
      "Download bases must be HTTP(S) directory URLs without credentials or query strings.",
    );
  }
  return url;
}

function assertHash(value) {
  if (
    typeof value !== "string" ||
    Buffer.from(value, "base64").length !== 64 ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw new Error("Every artifact must declare a SHA512 checksum.");
  }
  return value;
}

export function planManifest(source, options) {
  const version = releaseVersion(options);
  const base = directoryUrl(options.sourceBase);
  const manifest = parse(source);
  if (
    !manifest ||
    manifest.version !== version ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error(
      `Source manifest must describe release ${version} and its files.`,
    );
  }
  const artifacts = new Map();
  function rewrite(value, sha512, size) {
    if (
      typeof value !== "string" ||
      /(?:^|[\/\\])\.\.(?:[\/\\]|$)/.test(decodeURIComponent(value))
    ) {
      throw new Error("Unsafe artifact path.");
    }
    const url = new URL(value, base);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Artifacts must stay within the declared source directory.",
      );
    }
    const relativePath = decodeURIComponent(
      url.pathname.slice(base.pathname.length),
    );
    if (
      !relativePath.startsWith(`${version}/`) ||
      relativePath.includes("\\") ||
      relativePath.endsWith("/")
    ) {
      throw new Error("Artifacts must stay in their version directory.");
    }
    const checksum = assertHash(sha512);
    if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0))
      throw new Error("Invalid artifact size.");
    const existing = artifacts.get(relativePath);
    if (existing && existing.sha512 !== checksum)
      throw new Error("Conflicting artifact checksums.");
    artifacts.set(relativePath, {
      relativePath,
      sourceUrl: url.href,
      sha512: checksum,
      size: size ?? existing?.size,
    });
    return relativePath;
  }
  for (const file of manifest.files)
    file.url = rewrite(file.url, file.sha512, file.size);
  if (manifest.path) manifest.path = rewrite(manifest.path, manifest.sha512);
  for (const info of Object.values(manifest.packages ?? {}))
    info.path = rewrite(info.path, info.sha512, info.size);
  return {
    version,
    manifest: stringify(manifest),
    artifacts: [...artifacts.values()],
  };
}

function binaryResponse(response, label) {
  if (!response.ok || !response.body)
    throw new Error(`${label}: HTTP ${response.status}`);
  if (
    /(?:text\/html|application\/xhtml)/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    throw new Error(`${label}: received HTML instead of a release artifact.`);
  }
}

async function download(response, path, expectedHash, expectedSize) {
  binaryResponse(response, path);
  const hash = createHash("sha512");
  let size = 0;
  let prefix = Buffer.alloc(0);
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        if (prefix.length < 256)
          prefix = Buffer.concat([prefix, chunk]).subarray(0, 256);
        callback(null, chunk);
      },
    }),
    createWriteStream(path),
  );
  const sha512 = hash.digest("base64");
  if (!size || /^\s*(?:<!doctype html|<html)/i.test(prefix.toString()))
    throw new Error("Empty or HTML artifact.");
  if (expectedHash && expectedHash !== sha512)
    throw new Error("Artifact SHA512 mismatch.");
  if (expectedSize !== undefined && expectedSize !== size)
    throw new Error("Artifact size mismatch.");
  return { sha512, size };
}

async function verifyArtifact(response, artifact) {
  binaryResponse(response, artifact.relativePath);
  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  if (size !== artifact.size || hash.digest("base64") !== artifact.sha512)
    throw new Error("OSS artifact read-back mismatch.");
}

function ossUpload({ path, key, sha512, immutable, contentType }, options) {
  const args = [
    "api",
    "put-object",
    "--bucket",
    options.bucket,
    "--key",
    key,
    "--body",
    `file://${resolve(path)}`,
    "--content-type",
    contentType,
    "--cache-control",
    immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache, max-age=0, must-revalidate",
    "--metadata",
    `sha512=${sha512}`,
    "--region",
    options.region ?? "cn-shanghai",
    "--retry-times",
    "3",
  ];
  if (immutable) args.push("--forbid-overwrite");
  return new Promise((resolveUpload, reject) => {
    const child = spawn(options.ossutil ?? "ossutil", args, {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveUpload()
        : reject(new Error(`OSS upload failed for ${key} (exit ${code}).`)),
    );
  });
}

export async function mirrorRelease(options, services = {}) {
  const fetchUrl =
    services.fetch ??
    ((url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(15 * 60_000) }));
  const upload = services.upload ?? ((object) => ossUpload(object, options));
  const version = releaseVersion(options);
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(options.prefix ?? ""))
    throw new Error("A product/channel target prefix is required.");
  const sourceBase = directoryUrl(options.sourceBase);
  const targetBase = directoryUrl(
    `${options.targetBase ?? "https://download.seabrains.cn"}/${options.prefix}`,
  );
  const channel = parseReleaseVersion(version).isPrerelease ? "rc" : "latest";
  const platform = options.platform ?? "all";
  if (!["all", "macos", "windows"].includes(platform))
    throw new Error("Unsupported mirror platform.");
  const manifestNames =
    options.manifests ??
    (platform === "all"
      ? [`${channel}-mac.yml`, `${channel}.yml`]
      : [platform === "macos" ? `${channel}-mac.yml` : `${channel}.yml`]);
  if (
    !Array.isArray(manifestNames) ||
    manifestNames.length === 0 ||
    manifestNames.some((name) => !/^[a-z][a-z0-9-]*\.yml$/.test(name))
  ) {
    throw new Error("Explicit updater manifest filenames are required.");
  }
  const directory = await mkdtemp(join(tmpdir(), "desktop-oss-"));
  const receipt = {
    version,
    sourceBase: sourceBase.href,
    targetBase: targetBase.href,
    artifacts: [],
    manifests: [],
  };
  try {
    const pointers = [];
    const artifacts = new Map();
    for (const name of manifestNames) {
      const response = await fetchUrl(new URL(name, sourceBase));
      binaryResponse(response, name);
      let manifestSource = await response.text();
      if (name.endsWith("-mac.yml") && options.extraArtifacts?.length) {
        const manifest = parse(manifestSource);
        if (!Array.isArray(manifest?.files))
          throw new Error("Source manifest has no files.");
        manifest.files.push(...options.extraArtifacts);
        manifestSource = stringify(manifest);
      }
      const plan = planManifest(manifestSource, { ...options, version });
      pointers.push({
        name,
        content: plan.manifest,
        contentType: "application/yaml",
      });
      for (const artifact of plan.artifacts) {
        const existing = artifacts.get(artifact.relativePath);
        if (existing && existing.sha512 !== artifact.sha512)
          throw new Error("Manifests disagree about an artifact.");
        artifacts.set(artifact.relativePath, artifact);
      }
      const current = await fetchUrl(new URL(name, targetBase), {
        cache: "no-store",
      });
      if (current.status !== 404) {
        binaryResponse(current, name);
        const existingVersion = parse(await current.text())?.version;
        if (
          typeof existingVersion !== "string" ||
          compareReleaseVersions(existingVersion, version) > 0
        ) {
          throw new Error(
            "Refusing to roll back or replace an invalid OSS update pointer.",
          );
        }
      }
    }
    if (!parseReleaseVersion(version).isPrerelease) {
      const response = await fetchUrl(
        new URL("desktop-version.json", sourceBase),
      );
      if (response.status !== 404) {
        binaryResponse(response, "desktop-version.json");
        const text = await response.text();
        if (JSON.parse(text).version !== version)
          throw new Error("Source desktop-version.json names another release.");
        const current = await fetchUrl(
          new URL("desktop-version.json", targetBase),
          { cache: "no-store" },
        );
        if (current.status !== 404) {
          binaryResponse(current, "desktop-version.json");
          const currentVersion = (await current.json()).version;
          if (
            typeof currentVersion !== "string" ||
            compareReleaseVersions(currentVersion, version) > 0
          ) {
            throw new Error("Refusing to roll back OSS desktop-version.json.");
          }
        }
        pointers.push({
          name: "desktop-version.json",
          content: text,
          contentType: "application/json",
        });
      }
    }
    async function publishArtifact(artifact, response) {
      const path = join(directory, `artifact-${receipt.artifacts.length}`);
      const digest = await download(
        response,
        path,
        artifact.sha512,
        artifact.size,
      );
      const complete = { ...artifact, ...digest };
      const targetUrl = new URL(
        artifact.relativePath.split("/").map(encodeURIComponent).join("/"),
        targetBase,
      );
      const existing = await fetchUrl(targetUrl, { method: "HEAD" });
      let verifiedAfterConcurrentUpload = false;
      if (existing.status === 404) {
        try {
          await upload({
            path,
            key: `${options.prefix}/${artifact.relativePath}`,
            sha512: digest.sha512,
            immutable: true,
            contentType: artifact.relativePath.endsWith(".zip")
              ? "application/zip"
              : "application/octet-stream",
          });
        } catch (error) {
          const concurrent = await fetchUrl(targetUrl, { cache: "no-store" });
          if (!concurrent.ok) throw error;
          await verifyArtifact(concurrent, complete);
          verifiedAfterConcurrentUpload = true;
        }
      } else if (!existing.ok)
        throw new Error(`Cannot inspect OSS artifact: HTTP ${existing.status}`);
      if (!verifiedAfterConcurrentUpload) {
        await verifyArtifact(
          await fetchUrl(targetUrl, { cache: "no-store" }),
          complete,
        );
      }
      receipt.artifacts.push({
        path: artifact.relativePath,
        url: targetUrl.href,
        ...digest,
      });
      await rm(path);
    }
    for (const artifact of artifacts.values()) {
      await publishArtifact(artifact, await fetchUrl(artifact.sourceUrl));
      const blockmapUrl = `${artifact.sourceUrl}.blockmap`;
      const blockmap = await fetchUrl(blockmapUrl);
      if (blockmap.status !== 404)
        await publishArtifact(
          { relativePath: `${artifact.relativePath}.blockmap` },
          blockmap,
        );
    }
    for (const pointer of pointers) {
      const path = join(directory, pointer.name);
      await writeFile(path, pointer.content);
      const sha512 = createHash("sha512")
        .update(pointer.content)
        .digest("base64");
      await upload({
        path,
        key: `${options.prefix}/${pointer.name}`,
        sha512,
        immutable: false,
        contentType: pointer.contentType,
      });
      const url = new URL(pointer.name, targetBase);
      const response = await fetchUrl(url, { cache: "no-store" });
      if (!response.ok || (await response.text()) !== pointer.content)
        throw new Error("OSS pointer read-back mismatch.");
      receipt.manifests.push(url.href);
    }
    return receipt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { parseArgs } = await import("node:util");
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "source-base",
        "target-base",
        "prefix",
        "version",
        "source-tag",
        "manifests",
        "platform",
        "extra-artifacts",
        "bucket",
        "region",
        "ossutil",
        "receipt",
      ].map((key) => [key, { type: "string" }]),
    ),
  });
  if (!values.bucket) throw new Error("--bucket is required.");
  const receipt = await mirrorRelease({
    ...values,
    sourceBase: values["source-base"],
    targetBase: values["target-base"],
    sourceTag: values["source-tag"],
    extraArtifacts: JSON.parse(values["extra-artifacts"] || "[]"),
    manifests: values.manifests?.trim()
      ? values.manifests.trim().split(/\s+/)
      : undefined,
  });
  if (values.receipt)
    await writeFile(values.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}
