# 国内与海外同时分发

海外发布流程继续生成、签名和发布原有 R2 产物。各产品在海外发布成功后调用 `.github/workflows/mirror-oss.yml`，把对应版本同步到阿里云 OSS `seabrains-data-download`（`cn-shanghai`），通过 `https://download.seabrains.cn` 分发。复制不改变安装包字节、签名、产品身份或账号环境。

| 产品 / 渠道                    | 国内目录                                                                   |
| ------------------------------ | -------------------------------------------------------------------------- |
| SeaWork 2.x                    | `seawork/`                                                                 |
| SeaWork 3.x                    | `seawork/alpha/`、`seawork/beta/`、`seawork/stable/`，由产品发布元数据决定 |
| SeaDesign 内部测试 / 生产      | `seadesign/`、`seadesign-release/`                                         |
| VideoFlow 海外版 / 国内版      | `videoflow-desktop/`、`videoflow-desktop-cn/`                              |
| SeaHarness                     | `seaharness/`                                                              |
| SeaGames 官方 / SeaBrains 分发 | `seagame/`、`seagame/seabrain/`，各自的测试版再加 `test/`                  |

发布调用方显式传入源目录、目标目录、版本以及清单名称。SeaWork 3.x 的渠道和清单名继续从 `@seawork/protocol` 生成的发布元数据读取；SeaGame 的账号分发渠道与测试/生产渠道继续从其发布元数据读取。两个维度不能互相替代。没有已发布产物的渠道保持不存在。

## Actions 凭证与接入

调用方仓库配置 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 两个 GitHub Actions Secrets，并通过 reusable workflow 的 `secrets` 参数传入。手动补发时这两个 Secrets 也要配置到 release kit 仓库。凭证只注入上传步骤的进程环境，不写进下载清单、脚本参数或产物。

首次发布这份 kit 后，应把调用方的 `mirror-oss.yml@main` 和 `with.kit-ref` 同时固定到包含该工作流及脚本的同一提交。原有签名发布工作流的固定版本不需要修改。

```yaml
mirror-china:
  needs: release
  permissions:
    contents: read
  uses: SeaBrains/desktop-release-kit/.github/workflows/mirror-oss.yml@main
  with:
    source-base: https://downloads.seabrains.ai/seadesign-release
    target-prefix: seadesign-release
    source-tag: ${{ inputs.tag || github.ref_name }}
    kit-ref: main
  secrets:
    OSS_ACCESS_KEY_ID: ${{ secrets.OSS_ACCESS_KEY_ID }}
    OSS_ACCESS_KEY_SECRET: ${{ secrets.OSS_ACCESS_KEY_SECRET }}
```

只有双平台完成后才晋级清单的调用方，镜像 job 也只在双平台发布时运行。独立发布平台的调用方分别传入该平台的清单。macOS 的人工安装 DMG 若未列在旧更新清单中，由原发布 job 提供带 SHA512 和大小的 `extra-artifacts`；它会加入国内 macOS 清单。

## 校验和晋级

脚本拒绝版本不一致、跨源或越过版本目录的产物路径、HTML 下载结果以及 SHA512 不匹配。它复制清单中的 ZIP、DMG、EXE、NSIS packages 及已有的外部 blockmap，逐个通过国内域名完整下载并核对 SHA512。所有文件通过后才写入国内清单；正式版还同步源站已存在且同版本的 `desktop-version.json`。

版本目录对象禁止覆盖；重复执行会验证并复用相同字节。清单使用 `no-cache`，且拒绝把已有清单降到更低版本。国内清单的文件地址改为版本相对路径，客户端不会经由清单再次跳回海外 CDN。失败的镜像 job 不影响已成功的海外发布，可单独重跑。

已有版本可以直接补发，不重新构建、签名或调用通知步骤：

```bash
gh workflow run mirror-oss.yml --repo SeaBrains/desktop-release-kit \
  -f source-base=https://downloads.seabrains.ai/seadesign \
  -f target-prefix=seadesign -f version=0.9.0 -f platform=all
```

## 客户端与官网

国内官网从 `.env.production-cn` / `.env.development-cn` 读取国内来源；指定 RC、Alpha 等渠道时使用 `{ "manifestBaseUrl": "…", "channel": "rc" }`。海外环境文件继续使用原来源。清单不存在的平台不展示下载按钮。

镜像现存安装包不会改写其包内更新源。VideoFlow 国内版的下一次构建已改用国内 OSS feed。SeaDesign 已支持通过构建变量 `SEA_DESIGN_UPDATE_FEED` 指定 feed。SeaHarness 的更新检查受后端版本分发策略控制，必须由后端把返回清单的绝对文件 URL 配为国内域名，不能把其检查接口替换为静态 OSS 来跳过策略。现存客户端是否以及如何选择地区，需要与各产品原有构建渠道一起交付。
