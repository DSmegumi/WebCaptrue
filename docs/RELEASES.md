# WebCaptrue 发布与安装包管理

WebCaptrue 的浏览器安装包使用 GitHub **Releases** 发布，而不是 GitHub Packages。

## 为什么使用 Releases

`.crx` 是最终用户下载并安装的浏览器扩展二进制文件，不属于 npm、NuGet、Maven、Docker 等依赖包生态。GitHub Releases 更适合按版本提供：

- `WebCaptrue-X.Y.Z.crx`
- `SHA256SUMS.txt`
- GitHub 自动生成的 Source code ZIP / tar.gz
- 版本说明与变更记录

## 签名与暂存位置

签名私钥 **不允许进入 GitHub 仓库、Release、Actions Artifact 或 CRX 文件本身**。

当前私钥保存在：

```text
OneDrive/WebCaptrue/Signing Keys/WebCaptrue-signing-key.pem
```

已经签名、准备发布的 CRX 先保存在 OneDrive 的私有工作目录：

```text
OneDrive/WebCaptrue/Releases/X.Y.Z/WebCaptrue-X.Y.Z.crx
```

签名完成并通过本地校验后，将最终 CRX 复制到仓库的 `release-assets/` 目录。私钥目录不得创建分享链接，也不得进入仓库。

## GitHub 发布描述文件

GitHub 仓库保存每个版本的发布描述文件和对应的已签名 CRX：

```text
release-assets/X.Y.Z.json
release-assets/WebCaptrue-X.Y.Z.crx
```

其中记录：

- 版本号
- CRX 文件名
- 仓库内已签名 CRX 的相对路径
- 预期 SHA-256
- 预期文件大小

二进制文件必须通过本地 Git 提交并在提交前核对哈希，不能通过文本型连接器写入。Actions 会再次校验大小、哈希和 CRX3 结构。

## 自动发布

`.github/workflows/release.yml` 在 `main` 上的 `release-assets/*.json` 或 `manifest.json` 变化时运行，也支持手动 `workflow_dispatch`。

流程会：

1. 从 `manifest.json` 读取版本号。
2. 读取 `release-assets/X.Y.Z.json`。
3. 从仓库的 `release-assets/` 目录暂存签名 CRX。
4. 核对文件大小。
5. 核对 SHA-256。
6. 校验 `Cr24` magic 和 CRX3 版本字段。
7. 生成 `SHA256SUMS.txt`。
8. 创建 `vX.Y.Z` GitHub Release；如果 Release 已存在，则覆盖更新 CRX 和校验文件。
9. GitHub Release 自动提供源码 ZIP 和 tar.gz。

任何大小、SHA-256 或 CRX3 校验失败都会阻止发布。

## 新版本发布步骤

1. 完成源码开发和测试。
2. 更新 `manifest.json` 中的 `version`。
3. 使用 OneDrive 中固定的 WebCaptrue 签名私钥生成同版本 CRX。
4. 将签名 CRX上传到 `OneDrive/WebCaptrue/Releases/X.Y.Z/`。
5. 将 CRX 复制到 `release-assets/WebCaptrue-X.Y.Z.crx`。
6. 计算并确认 CRX SHA-256 和文件大小。
7. 新建/更新 `release-assets/X.Y.Z.json`，用 `sourcePath` 指向该 CRX。
8. 通过本地 Git 同时提交描述文件和二进制文件到 `main`。
9. GitHub Actions 自动创建或更新对应 Release。

固定使用同一签名私钥可以保持 Chrome 扩展 ID 不变，从而使后续版本被识别为同一个扩展。

## 安全要求

- 私钥只用于签名，不进入源码仓库。
- 私钥目录不得公开分享。
- OneDrive Releases 目录只存放准备公开发布的签名安装包。
- Release 中只发布公有安装资产和校验值。
- 发布前必须通过 Chrome 109 兼容性校验。
- 发布前必须确认 `manifest.json`、描述文件版本号与 CRX 文件名一致。
- 发布前必须确认 SHA-256 与实际签名包一致。
- 如签名私钥丢失，不能简单生成新私钥替代，否则扩展 ID 会改变。
