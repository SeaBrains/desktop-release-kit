# 接入清单

新产品用 caller workflow + org secrets 接入。机制在 kit，产品只提供参数和打包脚本。

## 1. 产品侧前置

electron-builder：

- `appId`、`productName` 按产品填写。
- `nsis.useZip: true`（安装器内是 `app-64.zip`；kit 同时接受 `app-64.7z`）。
- Windows 安装器 `artifactName` 必须匹配 `{installer-prefix}-${version}-${arch}-Setup.${ext}`。
- 打包命令走 `--publish never`。
- 输出目录按蓝本：mac → `dist/mac-release/`（`.dmg` / `.zip` / `.blockmap` / `latest-mac.yml`）；win → `dist/win-unpacked/`，安装器 → `dist/{installer-prefix}-*-Setup.exe`。

客户端 electron-updater feed **必须带 slug 路径**：

```js
autoUpdater.setFeedURL({ provider: "generic", url: `${downloadsBase}/${productSlug}` });
```

### macOS 安装交接契约（kit 会强制校验）

这两条错了，包依然能签名、公证、发布成功，**只有用户点更新时才会发现装不上**。kit 的 `Verify macOS updater contract` 会在打包后扫描产物，不满足就红。

**① `quitAndInstall` 前必须先置退出标志。**

托盘型应用通常在窗口 `close` 时隐藏而非退出：

```js
window.on("close", (event) => {
  if (isQuitting()) return;
  event.preventDefault();   // ← quitAndInstall 触发的 app.quit() 会被这里吞掉
  window.hide();
});
```

`quitAndInstall()` 走的是 `app.quit()`，如果标志没置位，退出被 `preventDefault()`，进程留在 run loop 里，Squirrel 的 ShipIt 永远等不到旧进程退出 —— 表现为下载完成后毫无反应，ShipIt 无限重试。所以：

```js
setImmediate(() => {
  markQuitting();               // 置位后 close 处理器才放行
  autoUpdater.quitAndInstall(false, true);
});
```

**② `autoInstallOnAppQuit` 在 macOS 必须是 `false`。**

`MacUpdater.quitAndInstall()` 只在这个值为 `false` 的分支里调 `nativeUpdater.checkForUpdates()`，而那一步才是让原生 Squirrel 从本地代理服务器取包、写 `ShipItState.plist` 的唯一触发点。设成 `true` 会跳过它，ShipIt 起来后找不到 state，报 `Could not read update request` 并每 2 秒重试。

### 建议：接入 updater 日志

排查上述问题时若没有日志，只能靠 `lsof` 看端口、`sample` 抓栈、扒 asar 反推代码。强烈建议：

```js
autoUpdater.logger = require("electron-log");
autoUpdater.logger.transports.file.level = "info";
```

Yarn workspace 脚本（kit 通过 `yarn workspace <workspace> …` 调用，不搬产品脚本）：

- `dist:mac` — 签名公证 macOS DMG + zip
- `dist:win-unpacked` — 未签名 `win-unpacked`
- `dist:win-installer` — 从已签名 `win-unpacked` 打 NSIS

若产品有 git submodule，caller 侧保持 pin；kit 的 macOS job 会 `submodules: recursive`。

## 2. Caller workflow

生产必须 pin commit SHA，不要用浮动 tag。

```yaml
name: Desktop Release
on:
  push:
    tags:
      - "desktop-v*"
      - "v*"
      - "desktop-macos-v*"
      - "desktop-windows-v*"
  workflow_dispatch:
    inputs:
      tag:
        description: "Existing tag to build (e.g. desktop-v2.1.0)"
        required: true
        type: string
      platform:
        required: false
        default: "all"
        type: choice
        options: [all, macos, windows]
jobs:
  release:
    # pin the kit commit; do not use @main or a moving tag in production
    uses: SeaBrains/desktop-release-kit/.github/workflows/release.yml@<pinned-sha>
    with:
      product-slug: seaharness
      workspace: dsh-plugin-desktop
      package-path: dsh-plugin-desktop
      installer-prefix: DSH-Desktop
      executable-name: SeaHarness.exe
      r2-bucket: seaharness-downloads
      downloads-base: https://downloads.seaharness.ai
      # 有 vendored submodule 时填，pin 不一致会在打包前失败（省掉 ~20 分钟公证）
      upstream-manifest: upstream.json
      upstream-submodule: deepseek-harness
    secrets:
      APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
      APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
      APPLE_ID: ${{ secrets.APPLE_ID }}
      APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
      APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      MAC_CSC_NAME: ${{ secrets.MAC_CSC_NAME }}
      CF_R2_ACCESS_KEY_ID: ${{ secrets.CF_R2_ACCESS_KEY_ID }}
      CF_R2_SECRET_ACCESS_KEY: ${{ secrets.CF_R2_SECRET_ACCESS_KEY }}
      JENKINS_SIGN_URL: ${{ secrets.JENKINS_SIGN_URL }}
      JENKINS_SIGN_USER: ${{ secrets.JENKINS_SIGN_USER }}
      JENKINS_SIGN_TOKEN: ${{ secrets.JENKINS_SIGN_TOKEN }}
```

`node-version`（默认 `22.23.2`）、`tag-prefix`（默认 `desktop-v`）、`upstream-manifest` / `upstream-submodule`（默认空，跳过 pin 校验）、`verify-published-bytes`（默认 `2000000`；设 `0` 则完整下载并逐个校验 sha512，慢但最严）可省略。

## 3. Secrets

11 个：`APPLE_CERTIFICATE`（p12 的 base64）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）、`APPLE_TEAM_ID`、`MAC_CSC_NAME`、`CF_R2_ACCESS_KEY_ID`、`CF_R2_SECRET_ACCESS_KEY`、`JENKINS_SIGN_URL`、`JENKINS_SIGN_USER`、`JENKINS_SIGN_TOKEN`。

**配在 repo 级，不要只配 org 级。** GitHub Free 计划的组织里，org secret 的 `visibility: private` / `selected` 对 private 仓库**不生效** —— API 能创建、能查到，但运行时注入的是空字符串。只有 `all` 且仓库是 public 才有效。

这个坑很隐蔽，因为解析优先级是 **repo > environment > org**：org 级配好时被 repo 级同名遮蔽，看不出问题；**删掉 repo 级才是对 org 级的第一次真实验证**。删完才发现不可用时，repo 级的值已经读不回来了（GitHub 不返回明文），只能从本地备份或原始渠道重取。

先确认计划等级再决定：

```bash
gh api orgs/<org> -q '.plan.name'   # free → 必须 repo 级；team/enterprise → 可用 org 级
```

失败特征：日志里 `CSC_LINK:` 后面是**空的**（而不是报值错误），签名步骤 2 秒内挂在 `A valid Developer ID Application certificate ... is required`。

Caller 的 `GITHUB_TOKEN` 需能读取本 kit（公开仓库，或同 org 允许访问 private repo）。R2 走 org Cloudflare 账户 endpoint。

## 4. Self-hosted `sign` runner

label `sign`，能访问内网 Jenkins 签名服务。签名 job **不 checkout 产品仓库**，只拉 kit 脚本 + GitHub Artifacts。

## 5. 发布验收

打 tag `desktop-vX.Y.Z`（或 `vX.Y.Z` / `desktop-vX.Y.Z-rc.N`）推送即可。

1. 等 `promote` job 绿。它包含 `Verify published artifacts are downloadable`：对 manifest 里每个 url 发真实 GET，拒收 `text/html`（CDN 把下载路径 rewrite 到 SPA 首页时，`HEAD` 会返回正确的 Content-Length，`GET` 却给一个几十 KB 的 HTML，只验 HEAD 发现不了）。
2. `curl -fsS <downloads-base>/<slug>/latest.yml`（prerelease 验 `rc.yml`）确认指针可读。
3. 用旧版本客户端触发检查更新，确认能拉到本次产物**并真的完成安装重启** —— 下载成功不等于安装成功，见上文 macOS 安装交接契约。

R2：版本产物 `<slug>/<version>/…`（`--immutable`：同内容已存在则跳过，异内容 412）；指针 `<slug>/latest.yml`、`<slug>/latest-mac.yml`、`<slug>/desktop-version.json`（prerelease 只写 `rc.yml` / `rc-mac.yml`）。feed = `{downloads-base}/{slug}`，manifest 内 url 为 `<version>/<file>`。

同产品可并发发布多个 tag（workflow concurrency 按 tag 隔离）。**指针是最后写入者胜**；强烈建议同一产品串行发布，避免短时间并发多个版本抢写 `latest*` / `desktop-version.json`。失败 tag 重跑是幂等的：已成功上传的同内容对象遇 412 会被跳过，不会卡死。

## 6. 回滚

重新对旧 tag 跑 workflow **不可行**：promote 在写 `desktop-version.json` 前比较 semver，现有版本 ≥ 本次则拒绝，避免旧 tag 把 latest 打回去。

回滚二选一：

- 发一个更高 patch（例如 `2.1.1`），产物指向要回退的构建；或
- 手动改指针（需 R2 凭证）：

```bash
printf '{"version":"2.1.0"}\n' > desktop-version.json
node scripts/r2-put.mjs --file desktop-version.json --bucket "$R2_BUCKET" \
  --key "$PRODUCT_SLUG/desktop-version.json" --endpoint "$R2_ENDPOINT"
# latest.yml / latest-mac.yml 同样覆盖，不要加 --immutable
```
