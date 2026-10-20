# 国内与海外独立发布

地区是独立的发布维度，国内和海外可以使用不同版本与不同代码提交。不要把海外每次发布自动同步成国内最新版。调用方决定地区、生产/测试环境、版本与更新源，release kit 复用签名和打包流程。

## SeaDesign 的地区与渠道

| 地区 / 环境 | Tag 前缀    | 更新源                                               |
| ----------- | ----------- | ---------------------------------------------------- |
| 海外生产    | `v`         | `https://downloads.seabrains.ai/seadesign-release`   |
| 海外测试    | `test-v`    | `https://downloads.seabrains.ai/seadesign`           |
| 国内生产    | `cn-v`      | `https://download.seabrains.cn/seadesign-cn-release` |
| 国内测试    | `cn-test-v` | `https://download.seabrains.cn/seadesign-cn`         |

`APP_REGION` 与 `APP_ENV` 传给两个平台的构建步骤，由产品把对应更新源烧入客户端。国内设置 `storage-provider: oss`，macOS 签名/公证结束后从本地 dist 直传 OSS，Windows 安装器签名完成后从签名 runner 的本地 dist 直传 OSS。海外默认 `storage-provider: r2`，继续发布到 R2。国内最终产物不经过 R2 暂存或下载；Windows 签名步骤之间原有的 RustFS 传递仍保留。

正式版与 RC 是每个地区、环境内部的渠道：正式版写 `latest-mac.yml` / `latest.yml`，`-rc.N` 版本写 `rc-mac.yml` / `rc.yml`；安装包在该目录的 `<版本>/` 下。四组目录互不覆盖。国内轨不创建归一化的 GitHub Release，避免 `cn-vX.Y.Z` 被归一化为 `vX.Y.Z` 后与海外同号 Release 冲突。

历史的 `download.seabrains.cn/seadesign/` 只是同版本镜像试验，不是独立国内版。其他产品接入时也应按其已有地区、版本与环境规则选择目录，不能仅因同属一个产品就共用更新指针。

## Actions 接入

调用方仓库配置 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 两个 Actions Secrets，仅传入 OSS 上传 job。桶为 `seabrains-data-download`，区域为 `cn-shanghai`，公共域名为 `https://download.seabrains.cn`。凭证不进入清单、命令参数或产物。

产品先解析并校验 tag，再给 `.github/workflows/release.yml` 传入地区、环境和存储后端。`uses` 与 `kit-ref` 固定到同一个 kit 提交。

```yaml
with:
  storage-provider: oss
  product-slug: seadesign-cn-release
  tag-prefix: cn-v
  app-region: cn
  app-env: production
  downloads-base: https://download.seabrains.cn
  oss-bucket: seabrains-data-download
  oss-region: cn-shanghai
  create-github-release: false
secrets:
  OSS_ACCESS_KEY_ID: ${{ secrets.OSS_ACCESS_KEY_ID }}
  OSS_ACCESS_KEY_SECRET: ${{ secrets.OSS_ACCESS_KEY_SECRET }}
```

OSS 凭证只在直传和指针晋级步骤中注入；R2 凭证对 OSS 发布可省略。其余构建、签名参数沿用产品配置。SeaDesign 的生产和测试工作流已移除 `mirror-china` job。

## 传输与校验

`setup-ossutil.mjs` 安装经过固定 SHA256 校验的官方 ossutil 2.4.0，支持 macOS arm64/x64 与 Linux x64。`oss-upload.mjs` 对大于 8 MiB 的文件使用 8 MiB 分片、最多 4 个并发请求。每个请求有连接、读取与进程期限，单文件上传和全量读回分别最多 10 分钟。失败时等待在途分片退出并终止该 multipart upload。日志标明文件、分片进度、上传完成、校验开始与校验完成的时间。

版本对象在 PutObject 和 CompleteMultipartUpload 上都禁止覆盖；重跑只复用读回 SHA512 完全相同的字节。本地文件先与签名后的清单核对，上传后完整读回校验，随后产生 `oss-receipt.json`。双平台都成功后，promote job 取得两份清单和收据，检查所有对象的长度与 SHA512 元数据，拒绝降版本，再发布更新指针并逐字回读。这个步骤不再重复下载整个安装包。同一产品的 OSS 发布串行运行，防止不同 tag 同时推进指针。

更新清单保留 `no-cache`，产物保持版本目录与不可变缓存策略。macOS 清单补入本地同版本 DMG，更新 ZIP 与已有 blockmap 一并上传；Windows 清单使用签名后重算的哈希。单平台补发不推进公共清单。

`test-direct-oss.yml` 在独立的 `integration-tests/direct-oss/<run>-<uuid>` 目录运行真实分片上传、读回、双平台指针、复用和禁止覆盖测试，并清理测试对象。它不构建、签名或发布产品版本。

历史 `.github/workflows/mirror-oss.yml` 仍可用于明确指定的旧产物补拷，但不再参与 SeaDesign 国内发版。

## 客户端与官网

官网的国内环境应读取对应国内目录；海外环境保留海外目录。RC 下载使用同目录的 `rc` 渠道。清单尚不存在的平台不展示下载按钮。

复制已有海外安装包只改变下载入口，不改变包内更新源或账号服务。独立国内版必须重新构建并内置国内 feed。地区服务端地址由产品配置，不能从 OSS 域名推导；SeaDesign 支持 `.env.<环境>-cn` 覆盖服务配置，尚未设置的项目沿用原环境配置。
