# 国内与海外独立发布

地区是独立的发布维度，国内和海外可以使用不同版本与不同代码提交。不要把海外每次发布自动同步成国内最新版。调用方决定地区、生产/测试环境、版本与更新源，release kit 复用签名和打包流程。

## SeaDesign 的地区与渠道

| 地区 / 环境 | Tag 前缀    | 更新源                                               |
| ----------- | ----------- | ---------------------------------------------------- |
| 海外生产    | `v`         | `https://downloads.seabrains.ai/seadesign-release`   |
| 海外测试    | `test-v`    | `https://downloads.seabrains.ai/seadesign`           |
| 国内生产    | `cn-v`      | `https://download.seabrains.cn/seadesign-cn-release` |
| 国内测试    | `cn-test-v` | `https://download.seabrains.cn/seadesign-cn`         |

`APP_REGION` 与 `APP_ENV` 传给两个平台的构建步骤，由产品把对应更新源烧入客户端。国内构建使用独立的 R2 目录 `seadesign-cn` / `seadesign-cn-release` 暂存签名产物，再调用 `.github/workflows/mirror-oss.yml`，将这个国内构建发布到 OSS 的同名目录。海外发布不运行国内 OSS job。暂存目录即使位于海外 CDN，也不属于海外版的更新流。

正式版与 RC 是每个地区、环境内部的渠道：正式版写 `latest-mac.yml` / `latest.yml`，`-rc.N` 版本写 `rc-mac.yml` / `rc.yml`；安装包在该目录的 `<版本>/` 下。四组目录互不覆盖。国内轨不创建归一化的 GitHub Release，避免 `cn-vX.Y.Z` 被归一化为 `vX.Y.Z` 后与海外同号 Release 冲突。

历史的 `download.seabrains.cn/seadesign/` 只是同版本镜像试验，不是独立国内版。其他产品接入时也应按其已有地区、版本与环境规则选择目录，不能仅因同属一个产品就共用更新指针。

## Actions 接入

调用方仓库配置 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 两个 Actions Secrets，仅传入 OSS 上传 job。桶为 `seabrains-data-download`，区域为 `cn-shanghai`，公共域名为 `https://download.seabrains.cn`。凭证不进入清单、命令参数或产物。

产品先解析并校验 tag，再给签名工作流传入 `product-slug`、`tag-prefix`、`app-region`、`app-env`、`create-github-release`；国内版本使用独立的 product slug。签名工作流和 OSS 工作流的 `uses` 与各自 `kit-ref` 必须固定到包含相应接口的提交。

```yaml
mirror-china:
  needs: [target, release]
  if: ${{ needs.target.outputs.app_region == 'cn' && needs.release.result == 'success' && (github.event_name == 'push' || inputs.platform == 'all') }}
  permissions:
    contents: read
  uses: SeaBrains/desktop-release-kit/.github/workflows/mirror-oss.yml@<kit-sha>
  with:
    source-base: ${{ needs.target.outputs.staging_base }}/${{ needs.target.outputs.product_slug }}
    target-prefix: ${{ needs.target.outputs.product_slug }}
    source-tag: ${{ needs.target.outputs.source_tag }}
    kit-ref: <kit-sha>
  secrets:
    OSS_ACCESS_KEY_ID: ${{ secrets.OSS_ACCESS_KEY_ID }}
    OSS_ACCESS_KEY_SECRET: ${{ secrets.OSS_ACCESS_KEY_SECRET }}
```

双平台发布完成后才晋级清单，补发单个平台不更新公共清单。macOS 的人工安装 DMG 若未列在旧更新清单中，可传入含 SHA512 和大小的 `extra-artifacts`，它会加入国内 macOS 清单。

## 校验和晋级

OSS 脚本拒绝版本不一致、跨源或越过版本目录的产物路径、HTML 下载结果以及 SHA512 不匹配。它复制清单中的 ZIP、DMG、EXE、NSIS packages 及已有的外部 blockmap，逐个通过国内域名完整下载并核对 SHA512。所有文件通过后才晋级国内清单；正式版还同步源站已存在且同版本的 `desktop-version.json`。

版本目录对象禁止覆盖；重复执行会验证并复用相同字节。清单使用 `no-cache`，拒绝降到更低版本。国内清单使用版本相对路径，客户端下载不会再跳回海外暂存目录。OSS 发布失败可单独重跑；国内客户端在 OSS 校验完成前继续使用原来的国内清单。

## 客户端与官网

官网的国内环境应读取对应国内目录；海外环境保留海外目录。RC 下载使用同目录的 `rc` 渠道。清单尚不存在的平台不展示下载按钮。

复制已有海外安装包只改变下载入口，不改变包内更新源或账号服务。独立国内版必须重新构建并内置国内 feed。地区服务端地址由产品配置，不能从 OSS 域名推导；SeaDesign 支持 `.env.<环境>-cn` 覆盖服务配置，尚未设置的项目沿用原环境配置。
