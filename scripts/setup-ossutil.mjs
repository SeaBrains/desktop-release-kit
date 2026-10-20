import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 官方 ossutil 2.4.0 下载表的 SHA256，安装步骤不接触发布凭证。
const archives = {
  "darwin-arm64": [
    "mac-arm64",
    "26e51080c6d6c9848fe3aea8a6b0cbd88453e65cd41c5a27573c59335a78a41d",
  ],
  "darwin-x64": [
    "mac-amd64",
    "86685f129c76dbf94d7f9298152e24bb895289d866cb1a6115aa141c1a1b455b",
  ],
  "linux-x64": [
    "linux-amd64",
    "85edf66b2fb7238f5c7e25cab820cf29312319fe4935b7c86a6b8485eb434f3c",
  ],
};
const entry = archives[`${process.platform}-${process.arch}`];
if (!entry)
  throw new Error(
    `Unsupported OSS runner: ${process.platform}/${process.arch}`,
  );
const [platform, checksum] = entry;
const name = `ossutil-2.4.0-${platform}`;
const directory = mkdtempSync(
  join(process.env.RUNNER_TEMP || tmpdir(), "ossutil-"),
);
const archive = join(directory, `${name}.zip`);
execFileSync(
  "curl",
  [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--retry",
    "3",
    "--max-time",
    "120",
    `https://gosspublic.alicdn.com/ossutil/v2/2.4.0/${name}.zip`,
    "-o",
    archive,
  ],
  { timeout: 180_000 },
);
if (
  createHash("sha256").update(readFileSync(archive)).digest("hex") !== checksum
)
  throw new Error("ossutil archive checksum mismatch");
execFileSync("unzip", ["-q", archive, "-d", directory]);
const bin = join(directory, name);
chmodSync(join(bin, "ossutil"), 0o755);
if (process.env.GITHUB_PATH)
  appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
console.log(`Verified ossutil 2.4.0: ${join(bin, "ossutil")}`);
