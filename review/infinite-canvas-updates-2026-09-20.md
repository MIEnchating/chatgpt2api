# 上游增量核查：2026-09-20

先核查更新与本地影响，随后按用户“合并并修复”指令完成下述功能移植和修复。保持 Go/Vite 架构，未调用付费模型。功能移植与全局布局修复分别提交，不发布版本。任务开始时已有的其它文档修改保持原样。

## 基准与版本

- 上次基准：`f30b8d7f8a01573d0332c98f214f4bf4d1e3de14`，2026-09-14。
- 本次通过 Git fetch 核实 main：`dd5519fa2aeb3d5022db38f53e94fc78bdf20ee5`，2026-09-17。
- 新增 2 个提交，合计 39 个文件、288 行新增、91 行删除。日期按上游提交的 UTC+8 日期列示。
- GitHub Releases API 核实最新正式发布仍为 [v0.7.1](https://github.com/tigerowo/infinite-canvas/releases/tag/v0.7.1)，发布于 2026-09-12；以下更新尚未进入新发布版。
- 当前本地基准已经是 `2e09322`（v3.0.15），不能继续按上次 v3.0.13 的代码判断。
- [完整增量 diff](https://github.com/tigerowo/infinite-canvas/compare/f30b8d7f8a01573d0332c98f214f4bf4d1e3de14...dd5519fa2aeb3d5022db38f53e94fc78bdf20ee5)。

## 两个提交

| 日期 | 提交 | 主要变化 |
| --- | --- | --- |
| 9 月 16 日 | [d0b7544](https://github.com/tigerowo/infinite-canvas/commit/d0b75449ff64d366a241174e19f88ca9bdedec60) | 视频结果读取 `video.url`；Agent 创建视频时应用尺寸比例；文本节点滚轮修复；小数积分与按视频秒数计费；默认生成视频声音；代理去除 Expect 请求头 |
| 9 月 17 日 | [dd5519f](https://github.com/tigerowo/infinite-canvas/commit/dd5519fa2aeb3d5022db38f53e94fc78bdf20ee5) | Agent 流式请求开关；带 @ 的引用标签恢复；Agent Plan 内置模型列表；minimax-m3 分类修正；积分日志用户/日期筛选；音乐导航项 |

## 实施前核查

| 更新 | 当前本地核查 | 建议 |
| --- | --- | --- |
| Agent 文本流式请求开关 | **缺少可选开关及请求透传。** `canvas-agent-request.ts` 和 `createChatGenerationTask` 没有 stream 参数，面板只有协议、推理、自动生成设置。后端已有 Chat/Responses SSE 汇总处理，不能说整个项目不支持流式。 | 值得补齐参数、持久化、UI 与现有任务合同的透传。 |
| Agent 视频节点尺寸 | **同类问题存在。** `page.tsx` 的 `buildVideoNode` 固定为 420×236；Agent 后续覆盖 `generation_video_size`，不改节点宽高。9:16 参数仍创建横屏占位节点；后续生成结果有另一个尺寸处理路径，影响范围是初始节点。 | 优先修复，按最终生效的比例计算初始布局。 |
| 粘贴带 @ 的引用 | **同类细节仍存在于 Agent 引用编辑器。** 实际执行本地 `parsePromptTokens("参考 @图片1", ["图片1"])` 得到普通文本 `参考 @` 和引用 `图片1`，@ 没纳入引用 chip，删除标签可能留尾符号。并非引用完全不识别。 | 将 @ 和已知引用作为整体处理，同时保持序列化一致。配置节点采用 `@[node:id]`，不能套用同一补丁。 |
| 方舟 Agent Plan 模型列表 | **上游改善了选择体验，我们仍需手填。** 上游在 `/api/plan/v3` 下返回内置的 17 个模型 ID，并没有发现可拉取模型列表的新接口。我们调用 `/models` 遇到 404 时提示手动填写套餐支持的模型。 | 可以增加经核验的候选列表；不能把静态列表当作当前账号可用模型或余额证明。 |

流式更新的边界：上游这次主要是请求 `stream=true` 并完整消费 SSE、拼接工具参数/推理、检查终止事件。该 diff 没有给 Agent 面板增加逐字文本回调；不能将提交标题直接解释为“聊天气泡已边收边显示”。Gemini 原生请求也改为选择 `streamGenerateContent`。我们当前 Agent 以 Chat/Responses 为显式合同，图片 Gemini 能力不等于 Agent Gemini 原生能力。

## 已有不同处理或取决于配置的项目

- **Grok2API 嵌套 URL**：上游后端优先增加 `video.url` 字段读取。我们由发布的视频契约 `polling.result_fields` 决定结果路径，已有点路径和数组下标解析能力；支持配置 `video.url` 或更深路径。现有 `TestVideoContractResponseFieldPaths` 覆盖 `data.outputs[0].url`。未读取部署数据库里的私有 Grok 契约，不能声称线上配置一定正确；缺该路径应修契约，而不是添加无差别递归 URL 猜测。
- **长文本滚轮**：上游从 onWheel 改为 onWheelCapture。我们文本节点使用 ScrollArea；画布 React 处理器与原生 wheel 处理器都排除 `.scroll-area-viewport` 和 `data-canvas-no-zoom`。静态检查未见相同拦截根因，本次未另做该滚轮行为的浏览器复现。
- **minimax-m3 分类（更正初次判断）**：生成时确实使用显式类型与契约，但进一步检查发现“拉取模型”的 UI 仍用 `model-capabilities.ts` 名称筛选，其中 `minimax` 会误匹配文本模型。这是本地同类问题，本轮已补上 M3 文本系列排除与回归测试。
- **代理 Expect**：上游 Next.js 通配代理移除 `Expect` 请求头。我们不是该代理实现，不需要照抄 Next.js 补丁。

## 其它实际改动

- 算力点、余额、日志和模型价格从整数改为两位小数；视频按秒数预扣，智能时长 `-1` 按 15 秒计算，帧数/帧率可折算时长。图片按张、文本/音频按次。
- 积分日志增加用户名/昵称搜索、用户显示名与日期筛选。
- 默认视频原生声音从关闭改为开启。这是上游默认策略变化，我们的契约与用户参数无需自动跟随。
- 添加“音乐创作台”导航配置。本次增量没有新增音乐页面或生成实现，不应统计成完整新音乐功能。
- 添加 `.gitattributes` 保证 shell 脚本 LF，以及文档/文案调整。

本项目没有上游同一套本地算力点账本；相关计费属于独立产品能力，不能当成画布 bug 修复直接搬入。

## 初次审查验证

- 已核对两个提交的源码 diff，不仅查看标题和 CHANGELOG。
- 用 TypeScript AST 提取并执行本地真实 `parsePromptTokens`、`buildVideoNode`；复现 @ 分离和 9:16 参数下 420×236 初始尺寸。视频参数读取采用受控替身，未发起生成。
- 定向运行已有 `go test ./internal/httpapi -run '^TestVideoContractResponseFieldPaths$' -count=1`，通过，确认契约嵌套结果路径能力；测试进程已退出。
- 本次新增可跟进项是 Agent 流式请求开关、视频初始比例、@ 引用整体化、Agent Plan 候选模型。9 月 15 日已完成的对齐范围并未覆盖这两个后续提交。

## 已完成的移植与修复

1. **Agent 流式请求开关**：运行设置增加开关，默认关闭；配置保存、普通规划、多轮工具请求、长期摘要、前端提交、HTTP 解码和任务队列完整透传布尔 `stream`，后端拒绝非布尔值。沿用 Chat/Responses SSE 消费，不增加 Gemini 原生协议或逐字气泡展示。
2. **流式完成检查**：进一步发现 Chat SSE 只检查读取错误，没有强制完成原因；现缺少 `finish_reason` 时失败返回，即使已经拼出合法工具 JSON 或收到 `[DONE]` 也不能当成功任务。Responses 原有 terminal event 检查保留。测试覆盖工具参数分片、终止事件缺失、两种协议开关状态。
3. **视频初始比例**：Agent 使用动作参数、Agent 设置或模型默认值的最终比例，同时计算节点尺寸和布局；手动创建、右键添加、连线后创建空白视频也采用模型比例与实际尺寸居中。覆盖横屏、竖屏、方形、像素尺寸以及参数优先级；已有生成和媒体尺寸路径保留。
4. **@ 引用整体化**：初次恢复和聚焦粘贴都将 `@` 纳入标签芯片；序列化保留原始引用文本，删除不遗留 `@`，保留多行文本、光标及节点 ID，避免图片 1 误匹配图片 10/100。配置节点的 `@[node:id]` 合同不变。
5. **方舟 Agent Plan 候选**：仅对显式 `/api/plan/v3` 路径返回内置目录，不通过捕获 404 切换行为。原生视频线路返回 5 个视频候选，OpenAI 协议自定义线路返回全部 17 个候选。保留身份鉴权，UI 明示候选不代表账号权限；标准 `/api/v3/models` 仍请求上游并保留错误。候选来自本次上游目录，未通过厂商账号或付费生成验证可用性。
6. **MiniMax M3 分类**：修正模型拉取筛选，M3 文本系列不再出现在视频候选中，同时保持 MiniMax/Hailuo 视频模型识别。

## 实施验证

- `npm run build`、`npm run lint` 通过，Lint 无警告；构建仍提示已有大 chunk 体积警告。
- `npm test`：969 项通过，0 失败（134 个测试文件）。
- `go test ./...` 全量通过；Go 定向测试也通过，包括请求队列透传、Chat/Responses 流式工具参数、未完成流拒绝、Agent Plan 目录与标准端点隔离。
- 通过已有 8002 Vite 开发服务加载真实 React 输入组件，使用临时 Playwright 浏览器验证：带 @ 内容恢复、聚焦多行粘贴、最长标签、未知标签、插入后光标、提交节点 ID、Backspace/Delete。浏览器已关闭，未新增开发服务。
- 视频比例通过执行实际页面创建/Agent handler 验证，未调用视频生成；无真实付费模型与套餐权限验证。
- 已核对并重启现有 `chatgpt2api.service`（工作目录为本仓库，启动命令 `go run ./internal`）；复用既有 Vite 服务，8002/8090 各一个实例。重启后模型接口无登录返回 401，源码服务鉴权正常。没有发布或重打 Windows 安装包。
