**infinite-canvas 与云棉对比记录 — 2026-09-15**

本文保留对齐开始前的审查结论和复现证据。随后已按用户确认实施对齐，当前完成状态与验证结果见 [执行记录](infinite-canvas-alignment-progress.md)。下文“当前缺失”描述的是审查基准，不代表对齐后的工作区。

结论：我们已经有多媒体画布、内置 Agent、创意工作流、统一文件存储及导演台，但尚未跟进上游后续的可管理 Skill、长对话记忆、Codex/MCP、媒体剪辑等能力。上游修复过的一部分交互、引用和文件生命周期问题，在当前代码里仍有对应缺口。

**核查基准**

- 上游：[tigerowo/infinite-canvas](https://github.com/tigerowo/infinite-canvas)，最新发布版 [v0.7.1](https://github.com/tigerowo/infinite-canvas/releases/tag/v0.7.1)，2026-09-12；当前 main 为 [f30b8d7](https://github.com/tigerowo/infinite-canvas/commit/f30b8d7f8a01573d0332c98f214f4bf4d1e3de14)，2026-09-14，包含尚未发版的素材分类和标签改动。
- 本项目：HEAD `5fd0adb`，2026-09-15；最近发布提交为 v3.0.13。本次判断包含当前已有的未提交修改，不能全部等同于已经部署的版本。
- 本地历史中，`3af9eef`（2026-07-19）引入无限画布，`070cab8`（2026-08-28）扩展多媒体工作区。未发现明确记录的最后参考上游 SHA，因此按功能、提交 diff 和当前调用链比较，不把时间区间内的提交数量当作缺失数量。
- 检查了上游 CHANGELOG、相关源码及提交差异；主要关注 7 月引入画布以来的演进，并逐项核对 8 月下旬至今的更新。没有修改业务代码、安装上游运行依赖或启动服务。
- 结论分别标为实际函数复现、静态代码确认、条件性差异和不适用。UI、云存储和真实模型调用未经本次端到端验证。

**近期更新脉络**

| 时间 / 版本 | 上游主要变化 | 我们当前情况 |
| --- | --- | --- |
| 7 月，v0.4.x | 多项目持久化、节点分组、画布侧栏、全景和导演台 | 主体能力已有；侧栏分组树仍有差距 |
| 8/9–8/21，v0.5.2–v0.5.5 | Windows 桌面客户端；MiMo/GLM/Gemini/Grok 音频；Seedream 图层拆分；导演台时间轴；多种图片接口 | 大部分模型能力和导演台已有；缺专用桌面安装包和完整原生渠道体系 |
| [8/27，57b13aa](https://github.com/tigerowo/infinite-canvas/commit/57b13aa) | 视频首尾帧、当前帧截取，提示词引用和放大编辑 | 截帧缺失，已有部分引用/编辑能力 |
| [8/28，6bd8b27](https://github.com/tigerowo/infinite-canvas/commit/6bd8b27) | 文字流式生成、分组元素树、Agent 消息复制 | 文字流式已有，后两项缺失 |
| [8/30，cd091cc](https://github.com/tigerowo/infinite-canvas/commit/cd091cc)，v0.6.0 | 可管理 Skill、Skill 附属文件、长记忆检查点、画布节点检索、Agent Chat/Responses 切换 | 我们只有内置领域 Skill、会话保存及 Chat 工具调用，新增部分未跟进 |
| [8/30，9e60175](https://github.com/tigerowo/infinite-canvas/commit/9e60175) | 媒体自动生成开关，修复图片连线参考图遗漏和顺序 | 开关缺失；已有图片节点覆盖连线参考图的问题仍存在 |
| [9/2，54b83aa](https://github.com/tigerowo/infinite-canvas/commit/54b83aa) | 工具参数严格校验、格式纠错、Skill 优先级、Seedance 2.5 时长修复 | 工具错误处理仍有缺口；时长在我们这边由视频契约控制 |
| [9/3，a27f046](https://github.com/tigerowo/infinite-canvas/commit/a27f046) | 首页 Skill 选择、推理开关、输入框多余换行修复 | 前两项缺失；换行问题仍存在 |
| [9/5，ea08dcb](https://github.com/tigerowo/infinite-canvas/commit/ea08dcb) | 模型渠道协议整理为静态内置模块 | 我们采用独立的视频契约体系，属于架构差异 |
| [9/6，51c4503](https://github.com/tigerowo/infinite-canvas/commit/51c4503) | 视频节点内进度条、分离音频、音频截取、截帧代理处理 | 尚缺这些节点操作；放大播放器已有进度条 |
| [9/7，79b8666](https://github.com/tigerowo/infinite-canvas/commit/79b8666) | 画布内 Codex、本地 Agent 服务、MCP 和插件 | 整套接入缺失 |
| [9/8，eebf893](https://github.com/tigerowo/infinite-canvas/commit/eebf893) | AutoDL ComfyUI 视频和音频工作流 | 缺失；现有创意工作流不是这类 GPU 工作流 |
| [9/8，163771b](https://github.com/tigerowo/infinite-canvas/commit/163771b)，v0.7.0 于 9/9 发布 | 自动云同步；历史释放后的无引用云文件删除 | 自动持久化主体已有；画布独占上传文件回收仍有缺口 |
| [9/11，0670c8f](https://github.com/tigerowo/infinite-canvas/commit/0670c8f) | 会话改名、回复节点定位、失选视频暂停、WebDAV MP4 扩展名、平移交互和 URL 复用 | 部分 UI 能力缺失；视频暂停等同类问题仍存在 |
| [9/12，7d45a88](https://github.com/tigerowo/infinite-canvas/commit/7d45a88)，v0.7.1 | 火山方舟 Seedance 独立协议，标准 API / Agent Plan，更新素材限制 | 已有火山视频驱动及可配置契约，但没有此专用原生直连模块 |
| [9/14，f30b8d7](https://github.com/tigerowo/infinite-canvas/commit/f30b8d7)；未发版 | 素材分类、标签编辑筛选，手填图片 URL 读取真实元数据 | 已有素材分组；标签交互、URL 元数据探测仍缺失 |

**真正值得补齐的功能**

| 能力 | 当前差距及建议 |
| --- | --- |
| 可管理的 Skill | 我们在 [canvas-agent-skills.ts](/root/workspace/chatgpt2api/web/src/app/canvas/agent/canvas-agent-skills.ts:17) 按关键词组合固定 Skill 文本；上游允许用户选择、导入、管理 Skill，系统 Skill 可按需读取附属文件。可在现有内置 Skill 上扩展，不需要重建整个 Agent。 |
| 长对话记忆 | [runtime](/root/workspace/chatgpt2api/web/src/app/canvas/agent/canvas-agent-runtime.ts:121) 仅保留最近 120 条协议消息；没有 token 预算、旧轮次摘要和超限压缩。会话能保存，但较早要求会直接丢弃。 |
| 大画布检索 | [context](/root/workspace/chatgpt2api/web/src/app/canvas/agent/canvas-agent-context.ts:75) 摘要限 120 节点，工具清单无 `query_canvas_nodes`。用户按标题找未进入上下文的第 121 个以后节点时，Agent 缺少发现其 ID 的工具；已知 ID 仍可读取，不能说完全不能处理大画布。 |
| Agent 先配置后生成 | 上游媒体自动生成开关默认关闭，先创建配置好的节点，再由用户提交。我们媒体工具创建节点后会执行生成，见 [page.tsx](/root/workspace/chatgpt2api/web/src/app/canvas/page.tsx:1898)。这是产品控制能力差异，不能把现有自动生成本身定为故障。 |
| Agent 接口与推理选择 | 上游支持 Agent Chat/Responses 选择和独立推理开关；我们的 [request](/root/workspace/chatgpt2api/web/src/app/canvas/agent/canvas-agent-request.ts:42) 使用聊天任务合同。能展示 `reasoning_content` 不等于有推理参数开关；图片已有 Responses 模式也不等于 Agent 已有。 |
| Codex / MCP | 上游包含本地服务、画布内 Codex 对话、模型与推理强度选择、授权、外部 MCP 和插件。目前我们没有对应模块。属于独立的大功能，不是替换几段提示词。 |
| Agent 对话易用性 | 消息一键复制、历史标题重命名、回复中的节点摘要卡片与点击定位，我们目前缺失，见 [canvas-agent-panel.tsx](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-agent-panel.tsx:401)。 |
| 视频 / 音频节点工具 | 缺首尾帧和当前帧截取、视频分离音频、音频时间范围截取，以及视频节点自身进度条。已有放大播放器、预览、下载和存素材；导演台截图是另外的功能。 |
| 分组树 | 已有组节点、分组拖动等，但 [canvas-side-panel.tsx](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-side-panel.tsx:376) 仍平铺节点；缺组内树形层级和折叠。 |
| 素材分类与标签 | 已有 [素材分组管理](/root/workspace/chatgpt2api/web/src/app/assets/asset-groups.tsx:12)，不应再做重复的分组系统；值得补标签编辑、过滤和画布侧栏使用。后端/数据结构已有 tags，但编辑 UI 会清空它，见下文。 |
| 手填 URL 的媒体信息 | [asset-form.tsx](/root/workspace/chatgpt2api/web/src/app/assets/asset-form.tsx:176) 修改 URL 会清空宽高、MIME、文件大小，提交时没有重新探测。本地上传会读取这些信息；仅手填 URL 路径有缺口。 |
| AutoDL ComfyUI | 上游读取工作流元数据及输入规则，支持 H3/Wan 视频和 IndexTTS 音频。我们没有 `autodl` 驱动或工作流元数据读取；现有私有/公开图片模板工作流不能替代。是否接入取决于是否实际使用 AutoDL。 |
| 火山方舟原生直连 / Agent Plan | 我们有 `volcengine-video` 和自定义请求路径，但默认走 `/v1/videos`，见 [relay.go](/root/workspace/chatgpt2api/internal/httpapi/relay.go:1089)。上游原生模块负责组装带 role 的混合 `content` 数组。不能将“可经 NewAPI 使用 Seedance”写成“没有 Seedance”，也不能将通用路径配置说成原生 Agent Plan 已完整接入。 |
| Windows 桌面安装包 | 上游 v0.5.2 已增加专用桌面客户端，当前 README 提供 Windows EXE 下载。我们现有部署侧重点为服务端及浏览器，不具备同等桌面产品形态。 |

**我们仍有的同类问题与触发条件**

1. **已有图片节点继续生成时，连线参考图被遗漏。实际函数复现。**

   在已有图片 A 上连接 B、C，再从 A 生成图片；[canvasGenerationReferenceImageURLs](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-generation-context.ts:194) 遇到 A.url 就直接返回 `[A]`，B/C 不进入 [生成请求](/root/workspace/chatgpt2api/web/src/app/canvas/page.tsx:3825)。上游 `9e60175` 改为合并连线参考图和自身图片，并保持引用顺序。实际调用返回 `["/images/A.png"]`，确认 B/C 丢失。

   本地 [现有测试](/root/workspace/chatgpt2api/web/tests/canvas-generation-context.test.mjs:309) 明确断言“自身图片替代上游参考图”，因此这是当前合同与上游修复后语义不同，不能称已有测试会防止的意外回归。修复时需要同步调整合同、引用编号和测试；不要影响明确指定参考图的局部编辑等路径。

2. **视频节点失选后继续播放。静态代码确认，待浏览器复测。**

   播放 A 后点击空白或选择 B，只要 A 未被卸载就仍会播放。上游 `0670c8f` 在选择状态变化时暂停视频；我们的 [CanvasVideoNodePlayer](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-video-player.tsx:21) 没有该 effect，暂停只有手动按钮或打开大预览。多个视频可能叠音。

3. **视频获取焦点后，复制 / 粘贴 / 删除快捷键被屏蔽。静态代码确认，待浏览器复测。**

   [播放按钮](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-video-player.tsx:33) 主动让 video 获取焦点，其祖先有 `data-canvas-no-pan`；[全局键盘处理](/root/workspace/chatgpt2api/web/src/app/canvas/page.tsx:4495) 对该祖先直接返回。选中视频并点播放后按 Ctrl/Cmd+C、V、Delete，无法进入画布快捷键分支。上游 `434da29` 修过同类问题。

4. **富文本输入出现多余换行。实际序列化函数复现，未做浏览器 E2E。**

   上游 `a27f046` 修复块元素和占位 BR 的重复处理。我们共享 [canvas-contenteditable.ts](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-contenteditable.ts:105) 仍会分别累加块边界与 BR；用实际导出函数和与现有测试相同方式的 DOM stub，`第一行 + DIV(BR)` 得到 `第一行\n\n`。该 helper 被 Agent 和配置输入共用，建议统一修复并补真实 DOM 结构覆盖。

5. **Agent 工具参数错误处理仍弱于上游。实际参数函数复现 + 静态运行链确认。**

   [parseToolArguments](/root/workspace/chatgpt2api/web/src/app/canvas/agent/canvas-agent-request.ts:136) 把无效 JSON 转成 `{}`；[runtime](/root/workspace/chatgpt2api/web/src/app/canvas/agent/canvas-agent-runtime.ts:50) 的动作校验抛错后直接结束这轮，没有把格式错误交回模型进行一次纠正。无必填项的工具还可能把空参数当有效调用。

   参数类型也存在静默转换：[helpers](/root/workspace/chatgpt2api/web/src/app/canvas/agent/canvas-agent-tools.ts:199) 对数字执行 `Number()`、对混合数组筛选而非拒绝。实际调用 `generate_video` 参数校验，`seconds:true` 被接受为 `1`，`sourceNodeIds:["A",123,false]` 被接受为 `["A"]`，未知字段被丢弃。后续视频契约仍可能拒绝值，但 Agent 参数边界已改变模型原始输入。上游 `54b83aa` 对这些情况做严格校验并反馈。

   我们已有工具白名单、必填项检查和执行前整批规范化；不能描述为完全无校验或必然执行半批。建议保留单一当前协议，补严格解析、类型/未知字段校验和有限纠错。上游原生工具→结构化 JSON→文本 JSON 的逐级 fallback 与本仓库“无兼容层”原则不同，不建议照搬。

6. **仅在画布使用的上传文件，失去全部引用后缺少自动回收。静态调用链确认，待真实存储验证。**

   触发：向画布直接上传文件，不加入“我的素材”，删除节点或项目，再离开画布/淘汰撤销历史。上游 `163771b` 将这些释放点接入无引用文件清理；我们 [removeNodes](/root/workspace/chatgpt2api/web/src/app/canvas/page.tsx:2339)、[历史截断](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-history.ts:23) 及 [项目删除](/root/workspace/chatgpt2api/internal/service/canvas_document.go:750) 没有对应对象删除入队路径，文件和存储记录会继续积累。

   现有 [素材删除队列](/root/workspace/chatgpt2api/internal/service/my_asset.go:408) 会检查画布等引用并重试，但它由素材删除触发，不能覆盖没有素材记录的画布独占上传。[媒体保留期清理](/root/workspace/chatgpt2api/internal/httpapi/generated_media_cleanup.go:57) 也不扫描全部 generic 存储对象。修复需要结合跨项目、素材、工作流、撤销历史和运行中任务的引用，不能在删除节点时直接删文件。

7. **WebDAV 的 MP4 在特定上传名下仍保存为 .bin。条件性静态确认。**

   上游 `0670c8f` 对 WebDAV 的 `.bin` + `video/mp4` 改为 `.mp4`。我们 [UploadReader](/root/workspace/chatgpt2api/internal/service/generic_storage.go:373) 只在没有扩展名时用 MIME 推断；上传 `clip.bin` 且 MIME 为 `video/mp4` 会保留 `.bin`。

   影响范围应限定：正常生成视频持久化会主动创建 `.mp4` 文件名，见 [generation-result-storage.ts](/root/workspace/chatgpt2api/web/src/services/generation-result-storage.ts:105)，所以不能说所有 WebDAV 生成视频都受影响。未运行真实 WebDAV 上传。

8. **本次额外发现：编辑素材会清空既有标签。静态代码确认。**

   若素材通过导入/已有数据带有 `tags:["产品"]`，仅在界面修改标题再保存，[asset-form.tsx](/root/workspace/chatgpt2api/web/src/app/assets/asset-form.tsx:111) 的固定 `tags:[]` 会覆盖原数据。不是上游日志明确列出的同名修复，但与本次标签功能差异直接相关。标签 UI 即使暂时不补，也应保留已有标签。

**已具备、不同架构已避开或还不能定为问题的项目**

| 上游变化 | 核查结论 |
| --- | --- |
| 导演台时间轴、关键帧速度曲线、网格、相机截图与标签缩放修复 | 已包含相同 `index-oQuo7db8.js` 构建，CSS/模型文件一致；JS 去除行边空白后仅有本地额外的摄像机目标保护差异。我们还已有 [复制对象不改原摄像机目标的测试](/root/workspace/chatgpt2api/web/tests/director-static.test.mjs:17)。无需重新移植整个导演台。 |
| 文字流式生成 | 已有，见 [文本任务进度更新](/root/workspace/chatgpt2api/web/src/app/canvas/page.tsx:3216)。本地通过持久化任务进度刷新文本，具体传输方式与上游不同。 |
| Images / Responses / Chat Completions 生图模式 | 已有 [图片模式分发](/root/workspace/chatgpt2api/internal/httpapi/image_api_modes.go:15)。不要将它与 Agent 文本接口切换混为一谈。 |
| MiMo、GLM、Gemini、Grok 音频与 Seedream 图层拆分 | 已有 [音频协议处理](/root/workspace/chatgpt2api/internal/httpapi/audio.go:143) 和 [图层拆分适配](/root/workspace/chatgpt2api/internal/httpapi/relay.go:2520)。实际可用性依赖配置的中转/厂家；本次未请求付费模型。 |
| 视频厂家扩展 | 已有 [12 类驱动](/root/workspace/chatgpt2api/internal/protocol/video_contract_drivers.go:3)、契约草稿/发布/回滚、字段映射、校验及任务快照；随仓库提供的默认契约只有 MiniMax H3，不能把驱动枚举数量等同于默认开箱可用模型数量，也没有核查线上私有契约。 |
| 自动云同步 | 已有 [生成结果自动持久化及失败保留](/root/workspace/chatgpt2api/web/src/services/generation-result-storage.ts:61)；上传目标按个人/全局 provider 或服务端本地选择。上游独立自动同步开关是策略差异。 |
| 私有云媒体分段读取 | 已有 WebDAV Range、S3 Range、本地分段流读取以及 HTTP 流式输出，见 [generic_webdav_storage.go](/root/workspace/chatgpt2api/internal/service/generic_webdav_storage.go:105) 和 [storage_files.go](/root/workspace/chatgpt2api/internal/httpapi/storage_files.go:244)。 |
| Base64 刷新丢图、Blob 提前释放导致撤销丢图 | 未发现上游相同根因。本项目登录后使用服务端 storageKey/任务持久化，游客本地渠道场景不适用。不能因此宣称所有存储失败场景均已排除。 |
| 节点标题混入参考图文件名、损坏图片 URL | 当前参考图使用固定 `canvas-reference-N` 文件名，按 MIME 选择扩展名，见 [page.tsx](/root/workspace/chatgpt2api/web/src/app/canvas/page.tsx:3973)，未见相同机制。 |
| Seedance 2.5 被硬限制为 15 秒 | 我们 Agent 读取模型视频契约，不应直接套用上游补丁；具体上限要检查部署中的该模型契约。随仓库的 H3 15 秒配置不能误报为 Seedance 的限制。 |
| 音频截取更改范围后试听起点不更新 | 我们还没有音频截取功能，这一修复目前不适用；以后补功能时应采用修复后的行为。 |
| 所选 Skill 被默认流程覆盖 | 我们没有用户可选 Skill，当前没有同样触发条件；新增该功能时需要明确 Skill 优先级。 |
| “继续/下一步”先查最新任务状态 | 上游提示词约束更明确；我们每轮也提供当前画布上下文，不能凭提示词少一句就断言一定误报完成。需要专门会话验证。 |
| 从媒体/面板表面按空格平移 | 当前 `data-canvas-no-pan` 仍会阻挡，见 [canvas-engine.tsx](/root/workspace/chatgpt2api/web/src/app/canvas/canvas-engine.tsx:290)。但我们已改为右侧抽屉，不宜把抽屉内部不平移直接当故障；视频表面的行为可另做交互确认。 |
| 远程 URL 复用，减少重复下载/Base64 | 上游 `0670c8f` 已优化，我们普通图片编辑仍下载为 File 后上传。是潜在性能优化；我们的受保护 `/api/files` 地址不能直接交给外部模型，需按实际接口和可访问性实现，不能直接替换全部路径。 |

**建议跟进顺序**

1. 先修参考图遗漏、Agent 参数处理、换行、视频焦点/失选行为，以及素材标签被清空。这些范围较小，直接影响正确性与操作体验。
2. 单独处理画布无引用文件回收。该问题会持续占空间，但实现需要完整引用保护、延迟回收与失败重试，应独立验证。
3. 补 Agent 节点检索与长对话记忆，再补媒体自动生成开关和可管理 Skill。它们能直接提高现有 Agent 的可控性和复杂任务能力。
4. 补视频截帧、音频分离/截取、节点进度条、分组树和素材标签筛选；优先复用现有媒体上传及存储合同。
5. Codex/MCP、AutoDL、方舟原生直连和桌面客户端作为独立需求，按实际使用场景决定。不要整包合并上游 Next.js/Gin/GORM 架构。

**许可记录**

上游 `cd091cc`（2026-08-30）把根 LICENSE 从 MIT 改为 AGPL-3.0，当前 README 也已更新。本地 [导演台 LICENSE](/root/workspace/chatgpt2api/web/public/director/LICENSE) 保留历史 MIT 文本。这是本次核对到的实质仓库变化：历史取得的版本和之后新增代码应分别记录来源与许可，不应继续把上游所有新代码统称为 MIT。

**验证记录**

- `bun test web/tests/canvas-generation-context.test.mjs`：27 项通过；另直接调用真实参考图 helper，确认连线 B/C 被遗漏。
- `bun test web/tests/canvas-agent-v2.test.mjs web/tests/canvas-video-player.test.mjs`：31 项通过。
- `bun test web/tests/director-static.test.mjs`：2 项通过。
- 存储子审查在 `web/` 运行 `bun test tests/image-storage.test.mjs tests/generation-result-storage.test.mjs tests/asset-storage-cleanup.test.mjs`：25 项通过。
- 合计 85 项现有测试通过；既有测试未覆盖部分新发现条件，参考图测试还明确固定了旧行为，故不能用“测试全绿”推导上述问题不存在。
- 另外执行了真实 Agent 参数规范化函数，以及真实输入框序列化函数的 DOM stub 复现；后者不是浏览器 E2E。
- 本次只生成对比记录，没有改业务代码、跑全量构建/Go 测试、修改运行配置、操作真实云端文件或调用真实生成模型。
