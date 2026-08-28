# desktop-release-kit

Reusable GitHub Actions pipeline for signing, notarizing, and publishing Electron desktop apps (macOS + Windows) to Cloudflare R2 with electron-updater manifests.

Signing, R2 upload, Jenkins dual-sign, and pointer promotion live in this kit. A product repo supplies parameters (~20-line caller workflow) and org secrets.

See [docs/onboarding.md](docs/onboarding.md).
