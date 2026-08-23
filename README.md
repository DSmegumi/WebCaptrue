# WebCaptrue

WebCaptrue 是一个面向内网、隔离网和受限办公环境的一键浏览器运行现场采集扩展。

它的目标不是单纯保存网页，而是在无法直接使用 Codex、Claude Code 等 AI 开发工具的环境中，把一次网页业务操作中浏览器能够观察到的关键数据完整保存下来，导出为一个 ZIP，之后再交给 AI 做接口梳理、网页分析、故障排查和辅助开发。

## 下载与安装

正式签名的浏览器安装包通过 **GitHub Releases** 发布。每个 Release 会提供：

- `WebCaptrue-X.Y.Z.crx`
- `SHA256SUMS.txt`
- 版本说明
- GitHub 自动生成的 Source code ZIP / tar.gz

开发和调试时仍可以通过 `chrome://extensions` 加载仓库目录。正式分发优先使用 Release 中的签名 CRX。

发布流程和签名管理说明见 [`docs/RELEASES.md`](docs/RELEASES.md)。签名私钥不会存放在 GitHub 仓库或 Release 中。

## 兼容基线

- Google Chrome 109+
- Windows 7 是硬性兼容目标
- Manifest V3
- 采集过程不依赖云端服务
- Chrome 109 是最低兼容线，不是功能上限；新版 Chrome 采用渐进增强

## v0.2.0 当前能力

- 一键开始 / 停止并导出 ZIP
- `chrome.debugger` + Chrome DevTools Protocol
- HTTP、XHR、Fetch 请求与响应
- Request / Response Headers、Body
- Sanitized HAR
- WebSocket、SSE/EventSource
- Console、Runtime Exception、Log
- JavaScript 动态脚本源码
- 已加载 HTML/CSS/JS/图片/字体/WASM 等资源补抓
- 页面 HTML 与结构化 DOMSnapshot（最佳努力）
- iframe / Worker / Shared Worker / Service Worker 相关 Target 发现与独立调试附加框架
- 跨 Target 唯一 requestKey
- 整页截图，失败自动回退可视区域截图
- 每个 frame 的 localStorage / sessionStorage
- 每个 frame 的 IndexedDB 与 Cache Storage 有界采集
- click / input / change / submit 操作时间线
- 操作唯一 interactionId
- XHR/Fetch 与最近用户操作自动关联
- API 动态 URL 归一化
- GraphQL operation 自动识别
- Request/Response JSON Schema 推断
- API initiator 摘要
- 面向 AI 的 `summary.json`、`workflow.json`、`api-index.json`
- 默认凭证字段脱敏
- Chrome 109 Offscreen Document heartbeat

## 使用方式

### 正式安装

从 GitHub Releases 下载对应版本的 `.crx` 安装包，并按照目标 Chrome 环境允许的扩展安装方式进行安装。

### 开发者模式

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，加载本仓库目录。
4. 打开需要采集的业务网页。
5. 点击 WebCaptrue 图标，点击“开始完整采集”。
6. 正常完成业务操作。
7. 再次打开 WebCaptrue，点击“停止并导出 ZIP”。
8. 在允许使用 AI 的环境中，将 ZIP 交给 Codex/其他分析工具。

录制期间不要主动打开同一标签页的 DevTools。Chrome 会使扩展的 debugger 调试连接与 DevTools 产生冲突。

## AI 分析入口

导出 ZIP 后，建议优先读取：

```text
ai/summary.json
ai/workflow.json
api/api-index.json
network/session.har
timeline.jsonl
```

其中 `workflow.json` 会尽量把用户操作和随后发生的 API 请求关联起来，`api-index.json` 则对接口进行路径归一化、GraphQL 识别和 JSON Schema 推断。

## 安全

采集结果仍可能包含内部 URL、业务数据、客户资料等敏感信息。

WebCaptrue 默认：

- 脱敏 `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`
- 不保存 password 输入值
- 递归脱敏常见 password/token/secret/session/apiKey 字段
- 普通输入框只记录字段信息和长度，不记录输入原文
- 不包含遥测或远程执行代码

即使经过默认脱敏，导出的 ZIP 仍应按照对应组织的信息安全要求处理。

## 开发与验证

无需构建即可作为 unpacked extension 加载。

```bash
npm test
```

项目开发规则见 [`AGENTS.md`](AGENTS.md)。完整目标、里程碑、当前功能和后续工作见 [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md)。发布流程见 [`docs/RELEASES.md`](docs/RELEASES.md)。

## 当前状态

v0.2.0 属于 Capture Completeness 阶段。核心录制架构已经形成，但仍需要重点完成 Chrome 109 / Windows 7 实机回归、Target 稳定性、大型会话保护、Source Map/源码重建以及更强的业务链路推断。
