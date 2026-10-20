import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import { planManifest } from "./mirror-release-to-oss.mjs";
import { prepareDesktopUpdateManifest } from "./prepare-desktop-update-manifest.mjs";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "./release-version-utils.mjs";
import { hashFile, logStage, objectUrl, uploadObject } from "./oss-upload.mjs";

function validateOptions(options) {
  parseReleaseVersion(options.version);
  if (
    !/^[a-z0-9][a-z0-9/_-]*$/.test(options.prefix || "") ||
    options.prefix.split("/").some((p) => !p)
  )
    throw new Error("Invalid release prefix");
  const base = new URL(options.downloadsBase);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid download base");
}

function plan(source, options) {
  return planManifest(source, {
    version: options.version,
    sourceBase: objectUrl(options.downloadsBase, options.prefix),
  });
}

export async function uploadRelease(options, services = {}) {
  validateOptions(options);
  if (!["macos", "windows"].includes(options.platform))
    throw new Error("Expected macos or windows");
  const upload =
    services.upload || ((object) => uploadObject(object, options, services));
  const log = services.log || logStage;
  const directory = await realpath(options.artifactsDir);
  const manifest = parse(
    prepareDesktopUpdateManifest(await readFile(options.manifest, "utf8"), {
      version: options.version,
    }),
  );
  if (options.platform === "macos") {
    if (!manifest.files.some((file) => file.url.endsWith(".zip")))
      throw new Error("macOS updater requires a ZIP");
    const dmgs = (await readdir(directory)).filter((name) =>
      name.endsWith(".dmg"),
    );
    if (!dmgs.length) throw new Error("macOS release requires a DMG");
    for (const name of dmgs) {
      if (!name.includes(options.version))
        throw new Error(`DMG does not match release version: ${name}`);
      const url = `${options.version}/${name}`;
      if (!manifest.files.some((file) => file.url === url))
        manifest.files.push({
          url,
          ...(await hashFile(join(directory, name))),
        });
    }
  }
  const prepared = plan(stringify(manifest), options);
  const files = [];
  // 所有本地字节先与清单核对，避免上传半套不一致产物。
  for (const artifact of prepared.artifacts) {
    const file = await realpath(
      join(directory, artifact.relativePath.slice(options.version.length + 1)),
    );
    if (!file.startsWith(`${directory}${sep}`))
      throw new Error("Artifact escapes its local directory");
    const digest = await hashFile(file);
    if (
      digest.sha512 !== artifact.sha512 ||
      (artifact.size !== undefined && digest.size !== artifact.size)
    )
      throw new Error(`Local artifact checksum mismatch: ${basename(file)}`);
    files.push({
      file,
      key: `${options.prefix}/${artifact.relativePath}`,
      digest,
      immutable: true,
    });
    try {
      const blockmap = await realpath(`${file}.blockmap`);
      if (!blockmap.startsWith(`${directory}${sep}`))
        throw new Error("Blockmap escapes its local directory");
      files.push({
        file: blockmap,
        key: `${options.prefix}/${artifact.relativePath}.blockmap`,
        digest: await hashFile(blockmap),
        immutable: true,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const receipt = {
    version: options.version,
    prefix: options.prefix,
    platform: options.platform,
    artifacts: [],
  };
  for (const object of files) {
    log("artifact:ready", object.key, { bytes: object.digest.size });
    await upload(object);
    receipt.artifacts.push({ key: object.key, ...object.digest });
  }
  await writeFile(options.manifest, prepared.manifest);
  await writeFile(
    options.receipt || join(dirname(options.manifest), "oss-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}

export async function promoteRelease(options, services = {}) {
  validateOptions(options);
  const fetcher = services.fetch || fetch;
  const upload =
    services.upload || ((object) => uploadObject(object, options, services));
  const log = services.log || logStage;
  const request = (url, init) =>
    fetcher(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  const prerelease = parseReleaseVersion(options.version).isPrerelease;
  const pointers = [];
  const artifacts = new Map();
  for (const [platform, folder, name] of [
    ["macos", "mac", "latest-mac.yml"],
    ["windows", "win", "latest.yml"],
  ]) {
    const directory = join(options.manifestsDir, folder);
    const prepared = plan(
      await readFile(join(directory, name), "utf8"),
      options,
    );
    const receipt = JSON.parse(
      await readFile(join(directory, "oss-receipt.json"), "utf8"),
    );
    if (
      receipt.version !== options.version ||
      receipt.prefix !== options.prefix ||
      receipt.platform !== platform ||
      !Array.isArray(receipt.artifacts)
    )
      throw new Error(`Wrong OSS receipt for ${platform}`);
    for (const item of receipt.artifacts) {
      if (
        typeof item.key !== "string" ||
        !item.key.startsWith(`${options.prefix}/${options.version}/`) ||
        item.key.split("/").some((p) => !p || p === "." || p === "..") ||
        /[\\\r\n]/.test(item.key) ||
        !Number.isSafeInteger(item.size) ||
        item.size <= 0 ||
        typeof item.sha512 !== "string" ||
        Buffer.from(item.sha512, "base64").length !== 64
      )
        throw new Error("Invalid OSS receipt artifact");
      const previous = artifacts.get(item.key);
      if (
        previous &&
        (previous.sha512 !== item.sha512 || previous.size !== item.size)
      )
        throw new Error("Conflicting OSS receipts");
      artifacts.set(item.key, item);
    }
    for (const item of prepared.artifacts) {
      const uploaded = receipt.artifacts.find(
        (file) => file.key === `${options.prefix}/${item.relativePath}`,
      );
      if (
        !uploaded ||
        uploaded.sha512 !== item.sha512 ||
        (item.size !== undefined && uploaded.size !== item.size)
      )
        throw new Error(
          `Manifest has no matching verified receipt: ${item.relativePath}`,
        );
    }
    pointers.push({
      name: prerelease ? name.replace("latest", "rc") : name,
      content: prepared.manifest,
    });
  }
  // 上传 job 已逐字读回验证；此处核对不可变对象的长度与 SHA512 元数据，避免再次跨网下载整包。
  for (const item of artifacts.values()) {
    const response = await request(objectUrl(options.downloadsBase, item.key), {
      method: "HEAD",
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) !== item.size ||
      response.headers.get("x-oss-meta-sha512") !== item.sha512
    )
      throw new Error(
        `OSS artifact missing or changed before promotion: ${item.key}`,
      );
  }
  if (!prerelease)
    pointers.push({
      name: "desktop-version.json",
      content: JSON.stringify({ version: options.version }) + "\n",
    });
  for (const pointer of pointers) {
    const response = await request(
      objectUrl(options.downloadsBase, `${options.prefix}/${pointer.name}`),
    );
    if (response.status === 404) continue;
    if (!response.ok)
      throw new Error(`Cannot read current pointer: HTTP ${response.status}`);
    const current = parse(await response.text());
    if (
      typeof current?.version !== "string" ||
      compareReleaseVersions(current.version, options.version) > 0
    )
      throw new Error(`Refusing to roll back ${pointer.name}`);
  }
  const directory = await mkdtemp(join(tmpdir(), "oss-pointers-"));
  try {
    for (const pointer of pointers) {
      const file = join(directory, pointer.name);
      await writeFile(file, pointer.content);
      await upload({
        file,
        key: `${options.prefix}/${pointer.name}`,
        immutable: false,
        contentType: pointer.name.endsWith(".json")
          ? "application/json"
          : "application/yaml",
      });
      log("pointer:published", `${options.prefix}/${pointer.name}`, {
        version: options.version,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "mode",
        "version",
        "prefix",
        "bucket",
        "region",
        "downloads-base",
        "platform",
        "manifest",
        "artifacts-dir",
        "receipt",
        "manifests-dir",
        "ossutil",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  const controller = new AbortController();
  process.once("SIGTERM", () =>
    controller.abort(new Error("Release cancelled")),
  );
  process.once("SIGINT", () =>
    controller.abort(new Error("Release cancelled")),
  );
  const options = {
    ...values,
    downloadsBase: values["downloads-base"],
    artifactsDir: values["artifacts-dir"],
    manifestsDir: values["manifests-dir"],
    signal: controller.signal,
  };
  const action =
    values.mode === "upload"
      ? uploadRelease
      : values.mode === "promote"
        ? promoteRelease
        : undefined;
  if (!action) throw new Error("--mode must be upload or promote");
  action(options).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
