# 接入清单

新产品用 caller workflow + org secrets 接入。机制在 kit，产品只提供参数和打包脚本。

## 1. 产品侧前置

electron-builder：

- `appId`、`productName` 按产品填写。
- **三处 `artifactName` 必须显式设置**（mac 的 dmg/zip、nsis），不许依赖 `productName` 缺省推导：`productName` 带空格时 electron-builder 会把 manifest 里的文件名替换成连字符，GitHub 资产又替换成点号，三个名字互相打架，manifest 指向的文件磁盘上根本不存在——打包、签名、上传全绿，接 R2 后客户端必 404。
- `nsis.useZip` **保持缺省（不要设 `true`）**：默认产物是 `app-64.7z`，NSIS 原生就能解。设 `true` 打出的是 LZMA 压缩的 `app-64.zip`，NSIS 的 `nsisunz.dll` 解不开，安装/更新一律死在解包（`Error opening ZIP file`）。kit 的产物校验两个名字都认，所以不需要为 kit 迁就 `useZip`。
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

### Windows 覆盖安装契约（产品侧自查，kit 不校验）

Windows 的坑和 macOS 对称：**首次安装永远正常，只有从旧版覆盖安装/自动更新时才炸**，而且报错信息会指向错误的方向。产品必须提供一份 `nsis.include` 指向的 `installer.nsh`，否则迟早撞上。

```yaml
nsis:
  include: build/installer.nsh
```

**① 「XXX 无法关闭，请手动关闭它然后单击重试」这句提示是假的。**

它不代表 App 还在运行。这句来自 app-builder-lib `include/installUtil.nsh` 的 `uninstallOldVersion`：它会执行**旧版本的卸载器**最多 5 次，只接受退出码 0，5 次都非 0 才弹这个框：

```nsis
UninstallLoop:
  IntOp $R5 $R5 + 1
  ${if} $R5 > 5
    MessageBox ... "$(appCannotBeClosed)" ...     ; ← 用户看到的框
  OneMoreAttempt:
    ExecWait '"old-uninstaller.exe" /S /KEEP_APP_DATA $0 _?=$installationDir' $R0
  CheckResult:
    ${if} $R0 == 0 → Return                        ; 只有 0 算成功
    Sleep 1000 → Goto UninstallLoop
```

判据：**进度条走到一半才弹**（不是安装器一启动就弹），且杀光所有进程、`$INSTDIR` 能自由 rename，点重试照样弹 → 就是这条。手动复现拿真实退出码：

```powershell
# 完全照抄安装器的调用形式，注意 _?= 和 --updated
& "$env:LOCALAPPDATA\Programs\<App>\Uninstall <App>.exe" /S /KEEP_APP_DATA /currentuser --updated "_?=$env:LOCALAPPDATA\Programs\<App>"
$LASTEXITCODE   # 非 0（常见 2）即命中
```

根因是 electron-builder#9593：旧版卸载器自身 abort（退出码 2）。**旧包已经发出去了，改不了了**，只能在新安装器里绕过它。解法是在 `customInit` 里删掉旧的 uninstall 注册表键——`uninstallOldVersion` 靠读 `UninstallString` 才能找到旧卸载器，读不到就整段跳过，新安装照常写新键：

```nsis
!ifndef BUILD_UNINSTALLER    ; 必须守卫：卸载器 pass 不插 customInit，
                             ; 未引用的 Var 会触发 NSIS warning 6001，而 warnings are errors
Var OldUninstallString
!macro customInit
  ; 仅覆盖安装才删；全新安装保持原生流程
  ${If} ${isUpdated}                                  ; --updated：自动更新relaunch
  ${OrIf} ...per-user XOR per-machine 存在旧安装...    ; 手动重跑安装器
    ReadRegStr $OldUninstallString SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $OldUninstallString != ""
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    ${EndIf}
  ${EndIf}
!macroend

; 删了键之后若安装中途 Abort，必须还原，否则用户的卸载入口就没了
Function .onInstFailed
  ${If} $OldUninstallString != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" UninstallString "$OldUninstallString"
  ${EndIf}
FunctionEnd
!endif
```

时序是安全的：`.onInit` 里 `initMultiUser`（给 `$hasPerUserInstallation` / `$hasPerMachineInstallation` 赋值）**先于** `customInit`。

**② 旧卸载器真跑起来且失败时，要响亮失败，不要试图抢救。**

用 `customUnInstallCheck` / `customUnInstallCheckCurrentUser` 接管：打印退出码、告诉用户去「设置 > 应用」手动卸载后重装，然后 `SetErrorLevel 2` + `Quit`，**现有安装原封不动**。

绝对不要用 `RMDir /r $INSTDIR` 强删来"修复"：NSIS 解压不是事务性的，wipe→extract 之间任何中断（关机、安装器被杀）都会让用户落到一个空目录、App 彻底没了。覆盖装在失败的卸载之上同样错——留下旧版残留文件和过期注册表项，把坏掉的安装状态掩盖过去。

**③ Electron 的子进程都叫同一个 exe 名，会导致真正的"进程没退干净"。**

渲染进程、GPU 进程、以及任何 `process.execPath` spawn 出来的 worker（node helper、node-pty、koffi 之类的原生 worker）在任务管理器里**都显示为主 exe 的名字**。App 正在退出时经常还挂着一两个，而 electron-builder 默认的 `customCheckAppRunning` 只探测不清理。用 `taskkill /T` 杀整棵进程树，再 `Sleep` + `Get-Process` 复验：

```nsis
!macro customCheckAppRunning
  loop:
    nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C taskkill /F /IM "${PRODUCT_FILENAME}.exe" /T'
    Pop $2
    Pop $3
    Sleep 3000
    ; 复验；仍在 → GUI 弹重试回 loop，静默装 SetErrorLevel 4 + Abort
!macroend
```

这和 ① 是**两个独立故障模式**，都要修：① 是旧卸载器坏了，③ 是真有残留 worker。

**④ `nsExec` 字符串里不许出现 PowerShell 的 `$` 变量**（`$_`、`$names`）。NSIS 会 mangle `$$` 转义，生成 ParserError 让脚本 abort——**而这恰恰就是让旧卸载器退出码变成 2、进而触发上面那个假提示的原因**。用单引号字面量的名字列表绕开：

```nsis
nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Process -Name '${PRODUCT_FILENAME}' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
```

`Get-Process` 的 `-Name` 不接受 `.exe` 后缀，且单引号能保住 `PRODUCT_FILENAME` 里的空格。

> 现成实现可直接抄 SeaWork `packages/desktop/build/installer.nsh` 或 SeaVerse Harness `apps/desktop/build/installer.nsh`。

**远程调试提醒**：通过 ssh 跑 Windows 安装器/卸载器时进程落在 **Session 0**（无桌面）。任何非静默的 GUI 会永久挂起，静默模式也可能因拿不到交互而走 `/SD` 默认分支返回失败——测出来的退出码不可信。要在真实交互会话里验证。

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
      r2-endpoint: https://<account-id>.r2.cloudflarestorage.com
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

**本 kit 是 public 仓库**——不是疏忽，是必要条件：kit 的每个 job 都要 checkout 自己的 scripts，而 caller 的 `GITHUB_TOKEN` 只对 caller 仓库有权限，private kit 的 checkout 必 404（同 org 也一样，Actions 的 Access 策略只放行 workflow 解析，不放行 git clone）。仓库内不含任何秘密：秘密全部走 caller 的 repo secrets，R2 account id 走 `r2-endpoint` input。禁止向本仓库提交任何 endpoint、内网地址、token。

## 4. Self-hosted `sign` runner

label `sign`，能访问内网 Jenkins 签名服务。签名 job **不 checkout 产品仓库**，只拉 kit 脚本 + GitHub Artifacts。

## 5. 发布验收

打 tag `desktop-vX.Y.Z`（或 `vX.Y.Z` / `desktop-vX.Y.Z-rc.N`）推送即可。

1. 等 `promote` job 绿。它包含 `Verify published artifacts are downloadable`：对 manifest 里每个 url 发真实 GET，拒收 `text/html`（CDN 把下载路径 rewrite 到 SPA 首页时，`HEAD` 会返回正确的 Content-Length，`GET` 却给一个几十 KB 的 HTML，只验 HEAD 发现不了）。
2. `curl -fsS <downloads-base>/<slug>/latest.yml`（prerelease 验 `rc.yml`）确认指针可读。
3. 用旧版本客户端触发检查更新，确认能拉到本次产物**并真的完成安装重启** —— 下载成功不等于安装成功，见上文 macOS 安装交接契约。

R2：版本产物 `<slug>/<version>/…`（`--immutable`：同内容已存在则跳过，异内容 412）；指针 `<slug>/latest.yml`、`<slug>/latest-mac.yml`、`<slug>/desktop-version.json`（prerelease 只写 `rc.yml` / `rc-mac.yml`）。feed = `{downloads-base}/{slug}`，manifest 内 url 为 `<version>/<file>`。

同产品可并发发布多个 tag（workflow concurrency 按 tag 隔离）。**指针是最后写入者胜**；强烈建议同一产品串行发布，避免短时间并发多个版本抢写 `latest*` / `desktop-version.json`。

### 重跑失败的 tag：只在产物逐字节可复现时才幂等

版本产物走 `--immutable`（`If-None-Match: *`）。412 时 kit 会取回已有对象比对 sha256：**完全一致才跳过**，否则抛 `R2 PUT rejected (If-None-Match): <key> already exists`。

因此重跑能不能过，取决于这次构建的字节是否和上次完全相同：

- macOS zip/dmg、`latest*.yml` 通常可复现，重跑一般能跳过。
- **Windows 安装器不可复现**：Jenkins 签名带时间戳，每次重签字节都不同。所以**只要上一次跑已经把 `<slug>/<version>/…-Setup.exe` 传上去了，后续任何重跑都会在这一步硬失败**。

失败特征是**失败点在多次重跑之间漂移**（这次挂 artifact 上传、下次挂某个 R2 PUT），因为每跑一次就多落一批对象，锁住更多路径。

判断方法——先看 R2 上这个版本是不是已经有部分对象：

```bash
curl -s -o /dev/null -w '%{http_code}\n' "<downloads-base>/<slug>/<version>/<installer>.exe"
```

返回 200 就**不要再重跑**了。两个选择：

- **推荐：换一个新版本号重发**（新 key 前缀，不与任何已有对象冲突）。旧版本号的对象成为孤儿，无害——`latest*` 指针从没指向过它们（promote 是最后一步，前面挂了就没写成）。
- 或者先把该版本前缀下的对象清掉再重跑。

注意 `promote` 的 job 条件是 `publish-macos` 和 `sign-windows` **都** success，所以只要有一条腿失败，指针不会被写坏——线上用户始终停在上一个可用版本。

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
