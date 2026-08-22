# WebCaptrue 项目目标与推进计划

> 当前版本：0.2.0（开发中）  
> 最低兼容基线：Google Chrome 109 / Windows 7  
> 设计原则：Chrome 109 是最低兼容线，不是能力上限；新版 Chrome 能力采用渐进增强，但不得破坏 Chrome 109 的核心采集能力。

## 1. 项目背景

WebCaptrue 面向无法直接连接 Codex、Claude Code 或其他 AI 开发工具的内网、隔离网和受限办公环境。

核心工作流是：

1. 在受限环境中安装 WebCaptrue。
2. 用户打开需要分析的业务网页。
3. 一键开始采集，不需要手工分别操作 DevTools、HAR、Console、截图工具或资源保存扩展。
4. 用户按正常业务流程完成查询、录入、提交、跳转等操作。
5. 一键停止并导出一个本地 ZIP。
6. 在允许使用 AI 的环境中，将 ZIP 交给 Codex/其他 AI，用于接口梳理、网页结构分析、问题排查和辅助开发。

WebCaptrue 不依赖云端服务完成采集，不要求受限环境能够连接 AI 服务。

## 2. 最终目标

最终目标不是简单的“网页下载器”或“HAR 导出器”，而是形成一个面向 AI 事后分析的浏览器运行现场采集器。

理想状态下，一次采集应尽可能保留浏览器能够合法观察到的以下信息：

- 页面 HTML、DOM 和结构化 DOM 快照。
- CSS、JavaScript、Source Map、图片、字体、WASM 等前端资源。
- 页面加载前已经存在的资源以及采集开始后的动态资源。
- HTTP/HTTPS 请求和响应。
- XHR、Fetch、REST、GraphQL。
- Request/Response Headers、Request Body、Response Body。
- WebSocket 和 SSE/EventSource。
- Console、Runtime Exception、浏览器 Log。
- 页面导航、iframe、Worker、Shared Worker、Service Worker 等相关运行目标。
- localStorage、sessionStorage、IndexedDB、Cache Storage。
- 用户点击、输入、选择、提交等操作时间线。
- 操作与网络请求之间的时间关联。
- 起始、关键操作、导航和结束页面截图。
- 可用于后续源码追踪的动态 JavaScript 源码和 initiator 调用信息。

导出的 ZIP 不能只是原始数据堆积，还要自动生成 AI 友好的索引，包括：

- 标准化 API 目录。
- 请求/响应 JSON Schema 推断。
- GraphQL operation 识别。
- 用户操作 → API 请求映射。
- 页面、Target、异常、主机、接口的整体摘要。
- AI 推荐读取入口和分析顺序。

最终希望实现：用户把一个 WebCaptrue ZIP 交给 Codex 后，AI 无需访问原内网，也能够最大程度重建“用户做了什么、前端执行了什么、调用了什么接口、服务器返回了什么、页面如何变化”。

## 3. 明确边界

WebCaptrue 只采集浏览器本身能够观察或通过浏览器授权调试接口读取的数据。

它不负责，也不应尝试：

- 获取服务器端 Java/C#/Python 等后端源码。
- 绕过登录、权限控制、验证码或访问控制。
- 获取未发送到浏览器的数据。
- 读取服务器文件系统、数据库或 Redis 的内部内容。
- 破解、提升权限或绕过企业安全策略。

因此“后端采集”在本项目中指浏览器可见的客户端—服务器通信，而不是服务器内部实现。

## 4. 安全与隐私目标

采集文件可能包含内部 URL、客户资料、业务记录和其他敏感数据，因此安全策略是产品能力的一部分，而不是后期附加项。

默认策略：

- `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie` 脱敏。
- password 输入值永不记录。
- 常见 `password/token/secret/session/apiKey` 字段递归脱敏。
- 页面输入默认只记录字段、选择器和长度，不记录原始输入值。
- IndexedDB、Cache Storage、Request/Response JSON 中继续执行常见凭证字段脱敏。
- 不使用遥测、统计 SDK 或远程执行代码。
- 采集和 ZIP 生成可以完全离线执行。

未来如增加“敏感认证数据完整采集”能力，只能作为明确的高级可选模式，必须有明显状态提示，且默认关闭。

## 5. 兼容策略

### 5.1 硬性基线

- Windows 7。
- Chrome 109。
- Manifest V3。

### 5.2 渐进增强

新版 Chrome 可以使用更新的 API 改善体验或稳定性，例如更现代的调试会话、Side Panel 或新的 CDP 字段，但必须满足：

- Chrome 109 仍可安装。
- Chrome 109 仍可完成核心采集和 ZIP 导出。
- 导出格式尽量保持一致。
- 新版能力必须有 feature detection 或回退路径。

### 5.3 当前针对 Chrome 109 的兼容措施

- 使用 Offscreen Document heartbeat 维持 Manifest V3 Service Worker 的长时间录制生命周期。
- 不依赖 Chrome 125 才加入 `chrome.debugger` 的 child `sessionId` 传输能力。
- 相关 iframe/Worker 优先采用 Chrome 109 已具备的 `targetId` 调试目标方式进行独立附加。
- 异步消息继续使用 callback + `return true`，不依赖更新版本才稳定支持的 Promise listener 行为。

## 6. 当前已经实现的功能

### 6.1 v0.1.0 基础框架

已完成：

- 一键开始 / 一键停止并导出 ZIP。
- `chrome.debugger` + CDP 采集架构。
- HTTP、XHR、Fetch 请求和响应。
- Request/Response Headers。
- Request Body 和 Response Body。
- 默认单个 Response Body 5 MB 上限。
- Sanitized HAR。
- WebSocket 帧。
- SSE/EventSource。
- Console、Exception、Log。
- `Debugger.scriptParsed` 和动态 JavaScript 源码。
- `Page.getResourceTree` / `Page.getResourceContent` 补抓采集开始前已经加载的资源。
- HTML DOM 快照。
- localStorage/sessionStorage 基础快照。
- 用户 click/input/change/submit 操作记录。
- password 和普通输入值默认不记录原文。
- 可视区域关键操作截图。
- 本地 IndexedDB 临时记录。
- 本地 ZIP 导出。
- Chrome 109 Offscreen heartbeat。
- 默认凭证脱敏。

### 6.2 v0.2.0 本轮增强

已实现/正在合入：

- 相关 iframe、Worker、Shared Worker、Service Worker Target 发现和独立调试附加框架。
- Root frame 与 child target 关系识别。
- 子 Target 独立 Network/Runtime/Debugger/Log 数据记录。
- Request ID 改为跨 Target 唯一 `requestKey`，避免不同 Target 的 CDP requestId 冲突。
- 每条请求/响应记录 Target 类型、URL 和 Target ID。
- 整页截图：`Page.getLayoutMetrics` + `Page.captureScreenshot(captureBeyondViewport)`，失败时回退到可视区域截图。
- 结构化 DOMSnapshot 最佳努力采集，失败不影响主流程。
- 每个 frame 的 localStorage/sessionStorage。
- 每个 frame 的 IndexedDB 数据库、Object Store、Index 和有限数据行采集。
- 每个 frame 的 Cache Storage 元数据及有限文本响应正文采集。
- 存储和缓存数据继续执行常见敏感字段脱敏。
- 用户操作获得唯一 `interactionId`。
- XHR/Fetch 自动关联最近用户操作，并记录 delay/confidence。
- API URL 路径标准化，例如动态 ID 自动归并为 `{id}`。
- GraphQL operation / operationName 自动识别。
- Request/Response JSON Schema 自动推断。
- API initiator 调用栈摘要。
- `ai/summary.json`。
- `ai/workflow.json`。
- `ai/capture-index.json`。
- `ai/analysis-guide.md`。
- AI 可直接从用户操作映射到对应 API。

## 7. 当前导出结构目标

```text
WebCaptrue_YYYYMMDD_HHMMSS.zip
├── manifest.json
├── README.txt
├── timeline.jsonl
├── ai/
│   ├── summary.json
│   ├── workflow.json
│   ├── capture-index.json
│   └── analysis-guide.md
├── api/
│   └── api-index.json
├── network/
│   ├── session.har
│   ├── requests.jsonl
│   ├── responses.jsonl
│   ├── response-bodies.jsonl
│   ├── websocket.jsonl
│   └── eventsource.jsonl
├── interactions/
│   └── actions.jsonl
├── runtime/
│   ├── console.jsonl
│   ├── exceptions.jsonl
│   ├── targets.jsonl
│   └── scripts/
├── dom/
├── storage/
│   └── client/
├── screenshots/
└── resources/
```

## 8. 后续仍需完成的工作

### P0：采集完整性与稳定性

- 在真实 Chrome 109 / Windows 7 上做端到端实机验证。
- 对 OOPIF、Dedicated Worker、Shared Worker、Service Worker 分别建立测试页。
- 验证 Chrome 109 中 `targetId` 独立附加在不同 Target 类型上的实际行为。
- 完善 Target 创建/销毁/重建后的自动重新附加。
- 页面刷新、SPA 路由跳转、跨域 iframe 更新后重新建立采集关系。
- 标签页崩溃、Debugger 被 DevTools 抢占、Service Worker 意外重启后的恢复逻辑。
- 防止超大页面、超大 IndexedDB、超大响应导致内存溢出。
- 把当前固定大小限制升级成“单项限制 + 会话总量限制 + 截断清单”。
- 支持采集过程中阶段性落盘，避免超长会话只存在浏览器 IndexedDB 中。

### P1：前端资源和源码追踪

- 自动解析并抓取 Source Map。
- Source Map → 原始源码文件重建。
- JavaScript bundle/module 依赖关系索引。
- `<script type=module>`、动态 import、Blob URL、data URL 进一步归档。
- Worker 脚本和 Service Worker 脚本单独目录和关系图。
- 页面资源去重和内容哈希。

### P1：API 与业务流程分析

- 更稳健的动态路径归一化策略。
- OpenAPI-like schema 输出。
- Query/FormData/Multipart 参数结构分析。
- GraphQL variables、fragment、operation 进一步解析。
- WebSocket message schema 推断。
- SSE event schema 推断。
- 操作与请求关联从单纯时间窗口升级为 initiator/frame/navigation 等多信号评分。
- 自动生成“页面功能 → 用户动作 → 前端调用位置 → API → 响应 → DOM变化”链路。

### P1：Storage

- IndexedDB/Cache Storage 增加分页和总量预算。
- 支持只保存 Schema、抽样和完整保存三档策略。
- Blob/File 类型可选导出为独立资源文件。
- Service Worker Cache 与网络请求建立引用关系。

### P2：用户体验

- 采集模式：标准 / 深度 / 自定义。
- 实时显示 Target、错误、存储、ZIP 预计大小等状态。
- 新版 Chrome 可选 Side Panel，Chrome 109 继续使用 Popup。
- 一键“标记关键步骤”，允许用户在业务流程中写简短备注。
- 导出前预览采集范围和脱敏状态。
- 大型 ZIP 生成进度显示。

### P2：AI 友好输出

- 自动生成 `architecture.json`。
- 自动生成前端框架/库检测结果。
- 自动生成 API 调用图。
- 自动生成页面导航/业务状态机草图。
- 为 Codex 输出统一任务提示模板。
- ZIP 格式版本兼容和迁移工具。

### P2：工程质量

- 建立专用测试网页 fixture。
- 自动化单元测试：URL 归一化、Schema 推断、脱敏、HAR、ZIP。
- Playwright/Chrome 自动化测试最新版 Chrome。
- Windows 7 + Chrome 109 使用单独人工/虚拟机回归清单。
- GitHub Release 自动打包可加载 ZIP。
- 版本变更日志和数据格式变更记录。

## 9. 建议推进里程碑

### Milestone A — Capture Completeness

目标：保证一次业务操作中绝大多数浏览器可见信息不会因为 iframe/Worker/Storage 而丢失。

完成条件：Target 体系稳定、Storage 体系稳定、Full-page screenshot 稳定、导出可承受中等规模业务会话。

### Milestone B — AI Reconstruction

目标：AI 不再需要人工翻 HAR，而是直接读取 WebCaptrue 索引还原业务链。

完成条件：API 归一化稳定、Schema 推断稳定、Action → API 映射可用、Source Map 和源码关系基本完整、AI summary/workflow/API catalog 结构稳定。

### Milestone C — Production Reliability

目标：能够长期用于真实受限网络环境。

完成条件：Chrome 109/Windows 7 实机回归、长时间采集和大数据量保护、异常恢复、标准/深度模式、Release 自动打包、完整文档和升级策略。

## 10. 当前优先级结论

目前不应优先追逐最新 Chrome 的 UI 或便利 API。当前最高价值工作顺序应是：

1. Chrome 109 真机兼容和 Target 稳定性。
2. iframe/Worker/Storage 的采集完整性。
3. 大会话稳定性和数据量保护。
4. Source Map/源码重建。
5. API + 用户操作 + DOM 的业务链路重建。
6. AI 输出格式稳定。
7. 新版 Chrome 渐进增强和 UI 改善。

只要前五项完成，WebCaptrue 才真正达到“内网离线采集 → 外部 AI 辅助开发”的核心产品目标。
