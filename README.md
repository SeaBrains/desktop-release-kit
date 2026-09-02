# desktop-release-kit

Reusable GitHub Actions pipeline for signing, notarizing, and publishing Electron desktop apps (macOS + Windows) to Cloudflare R2 with electron-updater manifests.

Signing, R2 upload, Jenkins dual-sign, and pointer promotion live in this kit. A product repo supplies parameters (~20-line caller workflow) and org secrets.

See [docs/onboarding.md](docs/onboarding.md).

Install-time contracts are the ones that bite: a build can sign, notarize, and publish green and still fail to install on the user's machine. Read both before shipping a new product — [macOS](docs/onboarding.md#macos-安装交接契约kit-会强制校验) (kit-enforced) and [Windows](docs/onboarding.md#windows-覆盖安装契约产品侧自查kit-不校验) (product-side, needs an `installer.nsh`).
