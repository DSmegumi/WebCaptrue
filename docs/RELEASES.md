# WebCaptrue 发布与安装包管理

WebCaptrue 的浏览器安装包使用 GitHub **Releases** 发布，而不是 GitHub Packages。

## 为什么使用 Releases

`.crx` 是最终用户下载并安装的浏览器扩展二进制文件，不属于 npm、NuGet、Maven、Docker 等依赖包生态。GitHub Releases 更适合按版本提供：

- `WebCaptrue-X.Y.Z.crx`
- `SHA256SUMS.txt`
- GitHub 自动生成的 Source code ZIP / tar.gz
- 版本说明与变更记录

## 发布资产

已经签名的 CRX 文件存放在：

```text
dist/WebCaptrue-X.Y.Z.crx
```

签名私钥 **不允许进入 GitHub 仓库、Release、Actions Artifact 或 CRX 文件本身**。当前签名私钥单独保存在用户 OneDrive 的 `WebCaptrue/Signing Keys` 目录。

## 自动发布

`.github/workflows/release.yml` 在 `main` 上的 `dist/*.crx`、`manifest.json` 或发布工作流发生变化时运行，也支持手动 `workflow_dispatch`。

流程会：

1. 从 `manifest.json` 读取版本号。
2. 要求存在同版本的 `dist/WebCaptrue-X.Y.Z.crx`。
3. 校验 CRX magic 和 CRX3 版本字段。
4. 生成 SHA-256 校验文件。
5. 创建 `vX.Y.Z` GitHub Release；如果 Release 已存在，则更新 CRX 和校验文件。
6. GitHub Release 自动提供源码 ZIP 和 tar.gz。

## 新版本发布步骤

1. 完成源码开发和测试。
2. 更新 `manifest.json` 中的 `version`。
3. 使用 OneDrive 中固定的 WebCaptrue 签名私钥生成同版本 CRX。
4. 将 CRX 放入 `dist/WebCaptrue-X.Y.Z.crx`。
5. 提交并推送到 `main`。
6. GitHub Actions 自动创建或更新对应 Release。

固定使用同一签名私钥可以保持 Chrome 扩展 ID 不变，从而使后续版本被识别为同一个扩展。

## 安全要求

- 私钥只用于签名，不进入源码仓库。
- Release 中只发布公有安装资产和校验值。
- 发布前必须通过 Chrome 109 兼容性校验。
- 发布前必须确认 `manifest.json` 版本号与 CRX 文件名一致。
- 如签名私钥丢失，不能简单生成新私钥替代，否则扩展 ID 会改变。
