# UI 组件覆盖审计

审计日期：2026-11-10。组件选型和开发规范以 [web/AGENTS.md](../web/AGENTS.md) 为准。

## 2026-11-10：并行改动后的最终复验

收尾核对发现上一轮验证后画布指针交互和消息渲染缓存有并行修改，予以保留并重新验证。新增的 Checkpoint 禁用属性使旧回归因要求 `editing` 必须是第一个属性而误报；本轮仅将该断言改为检查 Checkpoint 的编辑状态绑定，不依赖属性顺序，禁用行为继续由已有行为测试保护。组件覆盖复核未发现新的明确遗漏。

修正后相关 3 个测试文件的 176 项全部通过；当前 `npm run build`、`npm run lint` 通过，Lint 为 0 错误、0 警告；最终全量前端回归 189 个文件、1,513 项全部通过。最终构建前至测试完成后核对 660 个源码及测试文件，内容一致。日志为 `/tmp/chatgpt2api-component-handoff-{build,lint,focused,tests-final}.log`，快照为 `/tmp/chatgpt2api-component-handoff-snapshot-{start,result}.json`。未运行后端、桌面安装包或真实上游验证，本轮改动仍保留在工作区。

## 2026-11-10：当前前端整体验证

继续复核应用页面、共享组件和桌面入口的 347 个 TypeScript 文件（其中 235 个 TSX），对照当前官方 Prompt Input 与 Message 组合，并检查模型选择、附件、问答、推理、工具、任务、执行结果、来源和复制入口。本轮未发现新的明确替代点，未为增加组件导入而改写现有界面。

节点引用需区分用途：输入和消息附件已使用 Attachment；`CanvasAgentNodeChip` 用于 Markdown 句内的节点定位和执行结果导航，保留共享 Button，避免将含块级结构的附件卡插入段落。素材候选网格、普通配置编辑、画布坐标操作和第三方图形产物继续保留各自语义。素材预览复制失败后的文本选中仍是独立业务行为，未删除其手动复制入口。

本次 `npm run build`、`npm run lint` 执行通过，Lint 为 0 错误、0 警告；全量前端回归 189 个文件、1,512 项全部通过。构建前后及测试完成后核对 660 个源码和测试文件，内容保持一致。记录为 `/tmp/chatgpt2api-component-final-{build,lint,tests}.log` 和 `/tmp/chatgpt2api-component-final-snapshot-{start,result}.json`。本轮没有新增 UI 修改或浏览器截图，没有运行后端、桌面安装包或真实上游验证；此前浏览器结果按各轮记录保留。

## 2026-11-10：补齐问答消息和删除确认组合

- 历史问答记录原先只有 Bubble，现补齐共享 AI Elements `Message from="user"` 与 `MessageContent`。问题与回答继续显示在同一个用户气泡中，保留已回答、等待回答和已取消三种状态，取消时不制造回答。
- Agent 删除确认原先在 Confirmation 内用独立布局容器放置按钮，现通过共享 `actions` 接入 ItemActions。确认和取消仍调用原回调；共享组件允许仅含标题、说明和操作区的确认，不再要求空内容占位。

本轮 `npm run build`、`npm run lint` 执行通过；5 个相关回归文件共 134 项通过。复用既有 Vite 8002，以隔离数据完成 1440×960、320×740、844×390 与深浅主题共 6 组浏览器检查，每组覆盖普通容器及父 Dialog，验证长问题和长节点名、回答换行、等待与取消状态、Enter / Space 操作、模态视口和横向溢出。浏览器已关闭，未启动额外服务或执行真实删除。初次临时 HTML 缺少 UTF-8 声明造成中文测试数据乱码，补齐声明后完整复跑通过，未因此改动产品代码。

记录为 `/tmp/chatgpt2api-message-composition-{build,lint,tests,browser-final}.log`，截图为 `assets/ai-elements-message-composition-*.png`。工作区期间仍有其他前后端同步修改，本轮只报告相关组件的实际验证，不沿用此前全量结果作为当前整个工作区的验收。

## 2026-11-10：补齐 Codex 操作确认

再次对照 [官方 Confirmation 组合](https://ui.shadcn.com/docs/ai-elements/radix/confirmation) 检查执行审批。画布 Codex 的命令、文件和工具操作请求原先仍由 Dialog 和按钮独立拼装，现复用共享 `Confirmation` 的 Item、标题和操作区；Dialog 保留焦点管理和模态边界。操作说明与代码详情使用共享 `ScrollArea`，问题请求继续使用已有问答组件和独立草稿，不自动同意任何请求。

浏览器检查复现共享 Confirmation 的长标题截断与窄屏文字列过窄问题。标题现在完整换行，图标顶部对齐，确认和拒绝按钮可换行至下一行；保留官方外观，仅补充内容和操作区的布局约束。

聚焦回归先复现审批未使用共享 Confirmation，再验证显式确认、拒绝、关闭、AbortSignal 取消，以及多问题独立草稿和全部回答后继续的行为。审批浏览器验证覆盖 1440×960、320×740、844×390 与深浅主题，共 6 组，检查 Enter / Space、Escape、焦点返回、取消、长标题与详情滚动、多问题选择，以及视口边界。复用既有 Vite 8002，使用隔离组件与数据，验证结束后关闭浏览器，未启动额外服务。

工作区同期的视频任务状态改动予以保留，并按当前结构完成普通容器和 Dialog 的另外 6 组浏览器验证，覆盖排队、生成、0% 进度、100% 等待保存、终止、失败与保存重试及长错误滚动。早期视频脚本在源码同步变化时仍依赖旧 RunStatus 结构，不能作为当前版本结果；更新脚本并完成复跑后，以 `/tmp/chatgpt2api-video-status-browser-current.log` 为准。审批记录为 `/tmp/chatgpt2api-approval-browser-final.log`，截图为 `assets/ai-elements-approval-*.png` 和 `assets/ai-elements-video-status-*.png`。

本轮 `npm run build`、`npm run lint` 执行通过；5 个相关回归文件的 178 项全部通过。全量前端回归两次执行均为 189 个文件、1,502 项通过。最终一次测试期间检测到其他前端源文件同步变化（包含创作台侧栏），因此该结果表示实际执行通过，不表示冻结后的最终工作区快照已全部验收；本轮审批相关实现与测试在该期间未变化。随后按当前工作区重新构建与 Lint，均通过。记录为 `/tmp/chatgpt2api-approval-{build-delivery,lint-delivery,focused,all-tests-final}.log` 与 `/tmp/chatgpt2api-approval-test-snapshot.json`。未修改后端或桌面入口，未运行这些入口及真实上游认证的验证。

## 2026-11-10：补查组件内部与文档审核

继续检查共享组件内部的交互和实际调用，补齐四处遗漏：

- `CanvasAgentAnswerInput` 原先只有 Questionnaire 外壳，选项仍用 Button、Badge 和箭头拼接；现复用官方 `QuestionnaireChoice`、描述、原生 radio 与数字快捷键。保留立即回答、失败后重复选择重试、Enter/Space、中文输入确认、独立草稿及忙碌禁用，不因禁用隐藏问题，也不因 label 转发点击重复提交。
- 文档分析的文件入口复用 Attachment。文件名和大小、选择、更换、移除及重复选择保留；取消文件选择不清空原文件。窄屏将操作按钮排在下一行，长文件名完整换行。
- 文档生成契约的审核列表接入共享 TestResults，展示服务端返回的逐项干跑检查。仅为名称与当前契约对应且 `passed` 为真的结果显示通过项；保留原有失败不进入审核、检查范围及尚未实测上游的提示。
- `ContractReferenceMaterialPreview` 的素材占位不再独立拼接 FileUploadButton，改用创作台共享 `ReferenceFileUpload` 的 Attachment 组合。保留只读禁用、首尾帧、各类素材数量和规则隐藏条件。

补查同时覆盖其余 AI 输入、文件选择动作、问答、检查结果、代码复制和共享组件组合。普通 JSON/文档/配置编辑、文件导入动作、素材选择网格和图形编辑保留其基础组件语义。结论基于实际组合与行为，不以目录名或标记数量判断；本轮所检查范围内的明确遗漏已修复。

本次验证：

- `npm run build`、`npm run lint` 执行通过，Lint 检查 659 个文件，0 错误、0 警告；构建保留已有的依赖指令和分块大小提示。
- 问答、架构和 UI 交互回归 85 项通过；文档附件与素材预览的 2 项聚焦回归通过。全量执行 189 个文件、1,476 项：1,474 通过、2 失败。失败为 `upstream-oct27-regressions.test.mjs` 提取上下文缺少 `videoWorkbenchDisplayResolution`，以及 `shared-component-boundaries.test.mjs` 的脚本资产旧测试仍从已拆分的工作区加载 `ScriptAssetCard`。这两项在本轮改动前已出现；未为通过测试修改无关脚本或视频逻辑。
- 复用既有 Vite 源码服务，以隔离 API 数据完成 1440×960、320×740、844×390 的深浅主题共 6 组；问答和文档附件分别覆盖普通容器与父 Dialog。检查真实 radio/label 单次提交、重复重试、Enter/Space/数字键、自定义草稿、忙碌禁用、文件重复选择、更换和移除，以及真实文档分析 SSE 到审核 TestResults 的折叠/展开。另验证名称不匹配不显示通过、干跑失败不进入审核。调整文件布局后复跑窄屏深浅主题 2 组，通过。
- 截图为 `assets/ai-elements-followup-{question,review}-*.png`；记录为 `/tmp/chatgpt2api-followup-{build,lint,related,contracts,tests-final,browser,narrow-browser}.log`。浏览器均已关闭，未新启服务，未执行真实上游认证或后端测试。

## 2026-11-10：全局复核收尾

重新核查 `web/src/app`、`web/src/components`、`web/src/desktop` 的 349 个源文件（含 233 个 TSX 文件），并检查独立桌面入口及 `web/public/director` 的来源。按实际界面语义对照 [AI Elements 官方目录](https://ui.shadcn.com/docs/ai-elements)，检查组件组合、动态 DOM、原生输入、附件、模型选择、执行输出、代码与滚动；没有以导入路径或标记数量代替覆盖判断。

本次补齐：

- 创作台对话统一使用共享 `Conversation`，每轮为直接的 `MessageScrollerItem`；移除业务层的滚动阈值、底部状态、ResizeObserver、requestAnimationFrame 跟随和返回底部按钮。会话 ID 控制重建，异步历史加载和流式跟随由官方 MessageScroller 处理。
- 视频契约 Agent 执行输出也接入 Conversation 与条目，移除查找父弹窗并强制滚动的逻辑；输出区按视口限高，用户可上翻或返回最新。
- 插件干跑检查采用官方 `Test Results` 的 Trace 组合，仅显示 Worker 实际返回的通过项，不伪造失败或跳过结果。保留模拟数据、尚未验证上游与 New API 宿主的说明，删除结果区域自定义绿色配色。
- 工作流模板、产品、Agent 参考图和任务详情复用 Attachment/AttachmentGroup；保留移除、顺序、首尾移动边界、运行时禁用、文件名和原图链接。Skill 附属文件与公网参考 URL 列表也使用 Attachment，保留文件内容、单项移除和忙碌禁用；图片、视频、音频素材网格统一附件分组。
- Codex 启动说明使用 CodeBlock 的 Header、Title、Actions、CopyButton 和 Content。插件源码复制复用同一 CopyButton；复制失败通过已有剪贴板工具显示原因，成功保留图标与读屏反馈。启动说明浮层按可用高度约束，矮屏仍可滚动到复制按钮。
- 后台恢复的执行记录使用 Task 内的 TraceLine；普通事件只展示其实际文本，不制造工具调用或工具完成状态。

复核后的组件映射：

| 界面语义 | 统一入口或官方组合 |
| --- | --- |
| AI 输入、编辑和建议 | PromptInput、Suggestion；普通字段保持 Field/Input/Textarea |
| 对话、回复和滚动 | Message/MessageContent、MessageResponse、Conversation/MessageScrollerItem |
| 图片、视频、音频、文件与节点引用 | Attachment、AttachmentGroup、共享 ReferenceMediaCard、CanvasAgentAttachmentChip |
| 模型单选 | ModelPicker → Model Selector，保留搜索、分组和选中语义 |
| 推理、工具、执行记录与恢复 | Reasoning、Tool/ToolDetails、ChainOfThought、Task、RunStatus |
| 计划、排队、检查点与子代理 | Plan、Queue、Checkpoint、Subagent；待发送消息沿用官方 Trace 队列组合 |
| 确认、问答、上下文与来源 | Confirmation、Questionnaire、Context、Sources |
| 代码、终端、错误与检查结果 | CodeBlock、Terminal、StackTrace、TestResults |

保留的边界：Inline Citation 用于句内引用，目前来源是回答后的 Sources；File Tree 用于层级文件树，目前 Skill 仅有附属文件列表。图像蒙版、裁剪、全景、画布坐标/连线及资源候选缩略图保留专用图形结构；官方当前 Radix 目录没有这些图形编辑能力。素材生成结果的选中、图库多图预览、普通配置与管理界面保留其业务语义及 shadcn 基础控件。`web/public/director/assets` 是第三方预构建图形软件，不直接改写其压缩产物。本次复核未再发现应接入现有 AI Elements 能力的独立业务实现。

本次验证与限制：

- `npm run build`、`npm run lint` 本次执行通过；Lint 检查 656 个文件，0 错误、0 警告。构建保留已有的依赖指令及分块大小提示。
- 聚焦回归本次执行 5 个文件、176 项，全部通过，覆盖共享附件、工作流移动/移除/链接/禁用、URL 校验与数量限制、Skill 文件隔离、复制成功/失败/取消、契约工具详情和对话滚动架构。新增测试先复现缺失的附件组合、干跑结果及契约输出滚动入口。
- 最终全量前端回归本次执行 188 个文件：1,446 项通过，1 项断言执行失败和 1 项模块加载错误（Bun 汇总为 2 fail、1 error）。`upstream-oct27-regressions.test.mjs` 的视频音频默认值测试缺少 `videoWorkbenchDisplayResolution`；`canvas-script.test.mjs` 从当前 `canvas-script.ts` 导入不存在的 `scriptAssetsToGenerate`，该文件测试无法加载。这两处不在本次组件迁移修改范围内，未将全量记录为通过，也未为得到绿色结果修改无关实现。
- 复用现有 Vite 源码服务，隔离 API/会话数据，完成 1440×960、320×740、844×390 的深浅主题：真实创作台 6 组、创作台与画布 Conversation 6 组、工作流附件/插件结果/启动说明/Skill/契约执行输出 6 组，共 18 组。覆盖异步加载、直接子条目锚定、流式跟随、上翻不抢位置、回到最新、切换会话、附件操作、剪贴板内容、检查结果折叠、切换契约保留结果、窄屏与矮屏滚动边界。全部通过，浏览器实例已关闭，未另启服务。
- 截图为 `assets/ai-elements-global-{conversation,workflow,test-results,agent-output}-*.png` 和本轮复跑的 `assets/ai-elements-attachments-studio-*.png`。记录为 `/tmp/chatgpt2api-global-{build,lint,tests}-verified.log`、`/tmp/chatgpt2api-global-focused-completion.log`、`/tmp/chatgpt2api-global-{studio,conversation,components}-browser.log`。没有修改后端与桌面入口，未重复运行后端、桌面安装包或真实上游验证。

## 2026-11-10：复核附件组合与模型回复

再次对照 [AI Elements 官方目录](https://ui.shadcn.com/docs/ai-elements) 和 [Prompt Input 的附件组合](https://ui.shadcn.com/docs/ai-elements/radix/prompt-input) 检查页面、共享业务组件和桌面入口。官方当前直接组合 shadcn Attachment，因此本轮按真实结构和交互检查，不要求将其改为 `ai-elements` 目录下的转导出。

- `ReferenceMediaCard` 原先仍使用 Card、Button 和上传遮罩，现统一为 Attachment、AttachmentMedia、AttachmentContent、AttachmentTitle、AttachmentTrigger 及 AttachmentActions / AttachmentAction。创作台图片、视频、音频、首尾帧和画布视频参考素材均通过该共享入口更新；保留预览弹窗、视频首帧、上传禁用、移除禁用及矮屏排列。
- `ReferenceFileUpload` 使用 Attachment 的 `idle` / `uploading` 状态及预览触发区域，删除手绘上传卡片。保留文件类型筛选、数量限制、文件投放、重复选择同一文件、清空文件输入和并发上传锁。
- 创作台普通参考图、视频素材列表、历史消息参考图和画布节点引用列表改用 AttachmentGroup。普通参考图保留原有多图灯箱；节点引用保留 Tooltip 详情、双击或键盘定位，以及只断开当前引用的移除操作。缩略图移除按钮使用与官方组件一致的状态选择器定位，避免覆盖双击区域。
- 创作台模型回复原先仅复用 MessageHeader 和部分消息内容，现补齐 `Message from="assistant"` / MessageContent，文本与生成结果共享消息结构。
- 其余 AI 输入、模型选择、推理、工具、计划、任务、来源、确认和建议沿用已有共享入口。普通配置编辑和表单仍使用 shadcn；画布坐标、蒙版和媒体播放继续保留各自的专用交互。

本次实际验证：新增的附件预览、移除、上传锁和节点定位回归均先失败、替换后通过。聚焦架构、共享组件和 UI 交互的 160 项回归通过；`npm run build`、`npm run lint` 通过。最终全量回归为 188 个文件、1,450 项，1,448 通过、2 失败：视频分辨率大小写测试返回空值，以及视频音频默认值测试的提取上下文缺少 `videoWorkbenchDisplayResolution`。本轮未修改这些视频参数实现或测试；检查期间该部分工作区仍有独立变动，不将全量结果记作通过。

浏览器复用既有 Vite 服务，使用隔离数据检查 1440×960、320×740、844×390 的深浅主题，共 6 组共享附件与节点引用、6 组实际创作台检查，覆盖上传状态、重复文件、预览与 Escape、共享素材弹窗焦点返回、移除隔离、键盘/双击定位及视口边界。截图为 `assets/ai-elements-attachments-*.png`；记录为 `/tmp/chatgpt2api-attachment-{build,lint,focused,tests-final,browser,studio-browser}.log`。浏览器验证结束后关闭实例，未启动新服务。

## 2026-11-10：继续扫描 AI 输入与动态引用组件

个人设置的默认音频指令、图片系统提示词、视频系统提示词，以及工作流的批量追加要求，统一复用 `PromptInput`。保留原有保存接口、禁用状态及失败后的草稿；批量追加支持多行输入。普通文档、脚本正文、JSON、音色及配置字段继续按其编辑语义使用 shadcn 基础组件。

两类 contenteditable 引用标签原先通过动态 DOM 绘制外观和按钮，现在由 React Portal 复用共享 `CanvasAgentAttachmentChip`。DOM 仅保留编辑器所需的位置、数据标记及不可编辑语义；共享观察逻辑同步插入、删除和重建后的标签，保留原有序列化、复制、键盘删除、图片预览和只读行为。附件按钮的键盘事件不再冒泡触发 Agent 提交。

浏览器验证另复现并修复组装提示词选择 `@` 候选后只建立连线、没有在光标处插入引用的问题；Agent 待选引用现在过滤已提交和已失效资源，避免重复或删除后恢复。架构扫描补充 AI 指令字段、snake_case 模型字段、RadioGroup、导入别名及动态 `createElement` 控件，防止仅扫描 JSX 而漏掉独立实现。

本次实际验证：

- `npm run build` 通过；`npm run lint` 检查 655 个文件，0 错误、0 警告。构建保留已有的依赖模块指令和分块大小提示。
- 全量前端回归执行 188 个文件、1,441 项：1,440 通过、1 失败。失败项为 `upstream-oct27-regressions.test.mjs` 的视频音频默认值测试，提取函数的测试上下文缺少当前函数使用的 `videoDefaultReferenceMode`，报 ReferenceError；没有将该结果记作全量通过。本轮相关架构边界、共享组件与节点动作的 126 项回归另行执行，全部通过。
- 浏览器使用隔离 API 数据，在 1440×960、320×740、844×390 的深浅主题下，完成个人设置和批量追加的 6 组、两类引用编辑器的 6 组，以及三类引用菜单 × 普通容器/父 Dialog 的 36 组检查。覆盖保存失败保留与重试、多行更新、重复引用、预览不误提交、复制、删除、只读、失效资源、光标插入、键盘选择、逐层 Escape、焦点与视口边界。
- 记录为 `/tmp/chatgpt2api-scan-{build,lint,tests,browser}-final.log`、`/tmp/chatgpt2api-scan-focused-completion.log`、`/tmp/chatgpt2api-scan-{references,mention}-browser.log`；截图为 `assets/ai-elements-scan-*.png`。复用现有源码服务，验证浏览器均已退出，未修改后端或桌面入口。

## 补查：AI 输入与官方组件边界

再次对照 [AI Elements 官方目录](https://ui.shadcn.com/docs/ai-elements) 检查业务调用，补齐 5 处 AI 输入：创作台 Agent 回答、工作流系统提示词、负面约束、系列拆分说明和脚本资产生成描述，统一使用共享 `PromptInput`。Agent 回答同时复用 Footer、Submit 和 Spinner，阻止空回答与请求未结束时的重复提交，失败后保留草稿并允许重试。

截图中的 API Key 多选和默认密钥分组不是模型选择。官方没有专用的 API Key 多选组件，应使用同一套 shadcn Combobox；[Model Selector](https://ui.shadcn.com/docs/ai-elements/radix/model-selector) 对应模型选择，项目已有统一入口。不能把二者混为一谈，也不能仅因底层都由 shadcn 构成而绕过已有 AI Elements 组合。

本次其余核查结果：

- 消息、附件、推理、工具、计划、任务、建议、生成状态、确认和问答已有对应共享组合；模型单选经过 ModelPicker。
- 画布待发送消息使用 Trace 展示队列、条目与动作，符合当前 [Queue 的官方组合](https://ui.shadcn.com/docs/ai-elements/radix/queue)。执行计划另由共享 Queue 提供计划状态；不把待发送消息转换成计划步骤。
- 引用注解目前由 Sources 在回答后展示，符合官方来源列表模式；[Inline Citation](https://ui.shadcn.com/docs/ai-elements/radix/inline-citation) 用于句内引用，当前没有对应的句内引用界面。普通 Markdown 链接继续保留链接语义。
- File Tree 当前没有对应的层级文件树入口；插件干跑检查已在后续全局复核中接入 Test Results；终端与错误堆栈已有 Terminal、StackTrace。Skill 文档、脚本正文、JSON 和普通配置字段按各自编辑语义使用基础组件。
- 画布工具读取步骤不展示内部 JSON，失败仅展开可读错误；现有回归明确保护该行为，保留简洁展示。

本次实际验证：`npm run build`、`npm run lint` 通过；188 个文件、1,433 项前端回归通过。浏览器使用隔离 API 检查 1440×960、320×740、844×390 的深浅主题共 6 组，覆盖 Agent 键盘提交、忙碌禁用、失败保留与重试、草稿清空，以及工作流字段更新/保存禁用、脚本资产描述更新、共享输入边界及页面横向溢出。截图为 `assets/ai-elements-extra-*.png`，记录为 `/tmp/chatgpt2api-ai-extra-*.log`。

## 2026-11-10：优先采用 AI Elements，统一模型选择

用户确认的选型原则已写入前端规范：先查 AI Elements，有对应组件或官方组合就优先复用；普通基础控件沿用同一套 shadcn/ui，不再为同类交互各自拼装和维护样式。

- 新增共享 `ai-elements/model-selector.tsx`，采用 AI Elements 的搜索模型选择组合（Dialog、Command、分组、搜索、空结果及选中标记）。其依据为 [AI Elements Model Selector](https://elements.ai-sdk.dev/components/model-selector) 与 [shadcn AI Elements 的搜索迁移说明](https://ui.shadcn.com/docs/ai-elements/radix/model-selector)。当前 shadcn 示例的简单模型菜单使用 DropdownMenu，搜索场景保留 Command；本项目模型列表统一采用可搜索的组合，不同时维护两套模型菜单。
- 所有单选模型菜单经过 `components/model-picker.tsx`：创作台图片/视频与智能生成、历史图片编辑、画布各类节点及参数、Agent 对话及媒体、Codex 连接、脚本、局部重绘、工作流图片与 Agent、个人四类默认模型、契约分析及模型能力配置。删除各处独立 Select、DropdownMenu 和 Popover/Command 模型选择实现。
- ModelPicker 统一搜索、分组、选中标记、空结果、禁用及关闭逻辑；业务保留模型列表、标签、价格、参考图限制和原来的更新回调。创作台价格仍按所选 Key 显示，不自动改变缺失或空列表中的模型值。
- 补齐官方 Suggestion 组合，创作台图片预设、视频灵感和 Agent 建议使用同一入口；保留预设图片、完整提示词、填入输入框及焦点行为。
- 其他 AI 交互继续通过现有 PromptInput、Message/MessageResponse、Conversation、Reasoning、Tool、Task、Plan、Queue、Confirmation、Sources、Context、Checkpoint、Subagent、Terminal 和 StackTrace 组合。附件与问答使用当前官方模式依赖的 shadcn Attachment、Questionnaire；参数表单、权限、分类、音色和媒体控制保留对应基础组件。文件树目前没有对应界面，不安装无调用组件；插件干跑检查已在后续全局复核中接入 Test Results；坐标拖动及排序继续使用现有专用交互。
- 架构检查新增对独立模型 Select、RadioGroup 和模型搜索框的扫描（覆盖导入别名），并区分模型选择与能力类型字段。行为回归覆盖去重、空列表、缺失模型、禁用条件、选择与关闭、附加报价、弹窗命名和建议提示词；旧入口回归改为验证共享模型选择契约。
- 本轮最终 `npm run build`、`npm run lint` 通过；Lint 扫描 655 个文件，0 错误、0 警告；188 个文件、1,431 项前端回归全部通过，包含当前工作区的模型分组配置。构建保留已有的依赖模块指令及分块大小提示。
- 隔离组件浏览器验证共 8 组：1440×960、320×740 触屏、844×390、390×320，均覆盖深浅主题。验证 60 个模型的名称/ID 搜索、滚动、空结果、禁用选项、选中标记、键盘选择、一次 Tab 进入搜索、关闭返回触发器、父 Dialog 与 Popover 内选择、价格、Agent 无模型/忙碌禁用和建议提示词。所有弹窗保持在视口内。
- 自定义分组及顺序另在 390×320 深色下验证：模型选择使用当前分组配置，仍可搜索、选择、显示报价和返回父弹窗。
- 真实创作台、个人创作偏好、工作流编辑器及画布共 24 组检查（1440×960、320×740、844×390 × 深浅主题）。实际选择并更新模型；个人页四类默认值分别验证；画布验证搜索中的 Delete 不删除节点；没有页面横向溢出或浏览器运行异常。
- 复用既有 Vite 服务，所有 API 使用隔离数据；浏览器脚本在退出时关闭实例，未修改后端与桌面入口。构建、Lint、回归和浏览器记录为 `/tmp/chatgpt2api-ai-elements-*.log`，截图为 `assets/ai-elements-model-selector-*.png` 与 `assets/ai-elements-real-*.png`。

## 页面与共享入口

| 范围 | 已使用的共享组合 |
| --- | --- |
| 创作台 | `PromptInput`、`Message`、`MessageResponse`、对话滚动、生成参数面板 |
| 画布与 Agent | 提示词输入、消息编辑、问答、推理、工具及执行轨迹、任务、引用和 Skill 管理 |
| 画布脚本与局部重绘 | 分镜/视频提示词与修改要求使用 `PromptInput`，参数字段使用 `LabeledField` |
| 工作流列表、编辑器与运行器 | AI 输入、规划与生成状态、共享参数面板、历史清理确认 |
| 素材与提示词库 | 共享搜索、多选、卡片、空/加载状态、复制反馈与删除确认 |
| 个人设置与系统设置 | 共享设置工作区、字段、标签、Combobox、多选、确认、滚动和加载状态 |
| 用户、角色与日志 | 共享管理工作区、表单、权限编辑器、确认、分页和加载状态 |
| 登录 | shadcn 输入、密码输入、标签、复选框、提示和提交状态 |
| 桌面连接设置 | 独立 React 入口直接复用 Web 的字段、密码输入、RadioGroup、Card、Alert、ScrollArea、LoadingState；移除独立 HTML/CSS/JS 控件 |

前一轮补齐的共享能力：

- 业务加载图标使用 `Spinner`；19 处区域加载占位改用 `LoadingState`。
- 51 处纵向字段改用 `LabeledField`，67 处其余原生标签改用 `Label`；标题数值和字数通过字段 `meta` 单独排列。
- 14 处删除、清理和放弃修改确认改用 `ConfirmDialog`，保留条件文案、附加选项、禁用状态和异步操作锁定。
- 工作流、节点、脚本及局部重绘的 AI 输入接入共享 `PromptInput`；创作台消息经 `ai-elements/message` 组合。
- 多选统一使用官方 Combobox 组合；键盘提示和通用分隔线分别使用官方 `Kbd`、`Separator`。

## 本轮继续补齐

- 模型配置与筛选、权限列表、工作流变量与任务预览、用户统计、分享画布和画布侧栏统一复用 `EmptyState`。原先仅使用 `Empty` 外壳的手工组合也纳入检查。
- 历史与会话详情、素材同步、日志、AutoDL 参数、分享状态、上传提示、图片编辑及缩略图统一复用 `LoadingState`；支持紧凑提示与补充说明。
- 图片预览和画布素材占位使用官方 `Skeleton`，保留图片懒加载观察器和尺寸信息。鉴权图片仍由共享 `AuthenticatedImage` 处理内联图片的语义与错误占位。
- 素材、Skill、工作流、模型分辨率、契约与 Agent 确认的字段组改用 `FieldSet` / `FieldLegend`，保留原生禁用和分组语义；字段校验复用 `FieldError`。
- 音色描述与声音指令使用共享 AI 输入；分享节点使用 `Card` 并保留外部标题的显示空间；分享错误页保留一级标题语义。Agent 确认保留原因说明。
- 桌面连接页源码迁至 `web/src/desktop/`，从 Web 依赖独立构建到 `desktop/renderer/`，开发和打包入口会先构建。保留精确文件 URL、隔离 preload 和连接参数契约；连接仍禁止网络访问。CSP 仅按固定哈希放行 Radix 滚动区样式，不启用任意内联样式或脚本。

## 审计边界

### 继续扫描：组合层与交互语义

这一轮扩大到原生元素的 `role` / 点击与键盘处理、基础组件的皮肤覆盖、动态类名、共享样式常量和两个 CSS 入口，不再仅按原生表单标签判断覆盖。

- 提示词分类仍是 `Popover + Input + Button` 手工列表，现改用共享 `Combobox`，由组件提供选项语义、选中标记、键盘导航与收起行为；分类名称和来源 ID 均可搜索，显示配置名称。
- 工作流任务行原来用带 `role="button"` 的 `article` 包住复制按钮，键盘事件会冒泡到打开任务的处理。现使用 `Item` 排列独立的打开和复制按钮，移除手写按钮角色和按键模拟。
- 脚本参考图与资产上传原来将透明文件输入覆盖在按钮外观的标签上，现改为真实 `Button` 触发隐藏文件输入，保留文件选择清空、重复选择、运行中和生成中的禁用状态。
- 创作类型切换移除页面额外覆盖的胶囊圆角，保留响应式尺寸和官方 Tabs 外观。
- 画布主菜单从绝对定位的按钮列表迁至 `DropdownMenu`；项目设置从共享样式字符串拼接的滚动层迁至 `Popover`，移除两组重复外部点击监听。菜单继续支持创建、重命名、删除、导入导出、清空与撤销重做。
- 画布背景按钮原来接收但忽略 `active`，现与项目选择一起使用单选 `ToggleGroup`，保留选中语义、键盘移动与持久化。画布快捷键排除共享菜单与项目浮层，防止在菜单内删除节点或缩放画布。
- 架构扫描新增对原生元素模拟按钮、Combobox、单选、多选与选项角色的检查；行为回归覆盖分类检索、任务复制与打开隔离、上传入口和浮层键盘输入。

文本插入点的 `@` 引用菜单仍保留坐标与文本焦点处理，浮层外壳在后续扫描中收敛到共享组件。图形节点和裁剪继续保留专用交互。扫描结论针对本次检查范围，不将标签数量等同于所有场景已经得到验证。

### 继续扫描：参数浮层、上下文菜单与媒体预览

- 图片参数原来手写 Portal、位置同步和外部点击捕获，嵌套 Select 的选项位于独立 Portal，可能被当成外部点击。现直接复用 `CanvasParameterPopover`，保留模型去重、数量限制、展开模式、隐藏模型/尺寸和自定义尺寸输入行为；删除不再使用的定位函数及其几何实现测试。
- 共享参数浮层按 Radix 实际可用高度约束滚动，保留 8px 视口避让，并去掉标题下重复间距；这些约束同时作用于使用该封装的其他节点参数组。
- 画布右键菜单由手工按钮列表和预估高度迁至官方 radix-nova `ContextMenu`，接入项目共享层级。画布、节点与连线继续使用原有业务回调，由菜单 primitive 提供坐标定位、视口避让、选项语义、键盘导航、外部点击和 Escape 收起。
- 节点的“更多操作”同样从 `Popover + Button` 列表迁至共享 `DropdownMenu`，保留忙碌禁用、切图、比例锁定、反推、替换和视频截帧，以及选中操作后对新弹窗的焦点归属。
- 视频和全景预览的外壳改用共享 `Dialog`，保留专用播放/全景画面交互。视频空格快捷键只作用于预览表面或视频，避免拦截关闭、下载和音量等按钮的原生键盘操作；媒体区沿用图片灯箱的深色主题作用域，修复浅色主题下控件与画面混在一起的问题。
- 浏览器验证进一步发现：没有 `DialogTrigger` 的受控 Dialog 关闭后无法返回打开入口。修复落在共享 `DialogContent`，仅恢复仍连接的有效来源元素，尊重调用方的焦点处理；来源为 body 时继续交由原生 Dialog 处理。回归覆盖普通、已移除和 body 来源，以及调用方主动接管关闭焦点的情况。
- 等待真实 WebGL 画面完成后，还复现了开发模式 StrictMode 重复挂载导致全景请求中止、加载状态不结束的问题。Viewer 初始化移至首个有效渲染帧，清理时取消未执行的初始化并销毁已创建实例；回归先复现被丢弃挂载启动请求的问题，再验证取消、正常 ready 和实例清理。

### 继续扫描：引用下拉的共享组合与输入焦点

- 三个 `@` 引用入口（资源文本框、Agent 提示词、组装提示词）原先分别维护 Portal、定位和按钮列表，现统一复用 `CanvasMentionMenu`，由官方 `Command` / `CommandList` / `CommandItem` 和 `Popover` 组合。删除三套估算菜单高度、边界夹取和重复浮层留白；不重复显示同一资源的标题。
- 编辑器或插入点以 virtual anchor 接入 Popover，保留中文输入、原有候选过滤与引用插入。浮层使用实际可用宽高及弹窗边界；Command 自管滚动，受控选中项另保持可见，不夺走编辑器焦点。
- 先复现资源文本框的方向键和 Escape 冒泡，再修复已消费按键的事件隔离。浏览器另复现组装提示词的 Escape 重新打开：Radix 提前关闭会改变编辑器处理时的状态，现让保留焦点的编辑器先处理 Escape。
- 浏览器还复现失焦后的 120ms 定时器会关闭快速重开的菜单。共享选项选择已经保留输入焦点，三个入口改为失焦直接关闭，删除延迟定时器；回归保护快速离开再输入、重复选择防护、候选滚动及关闭后的外部焦点归属。
- 进一步复现 contenteditable 的待执行插入点更新会在 Escape 后重开菜单。两类 contenteditable 编辑器在关闭与卸载时取消更新，新的调度也会替换旧帧；先以待执行回调复现，再验证关闭不会被旧更新撤销。

扩大扫描范围后，业务层剩余的 23 处原生控件为 19 个文件输入和 4 个画布操作按钮；业务代码中没有原生 `fieldset` / `legend`。这 4 个按钮用于移动端面板遮罩、裁剪手柄和面板宽度拖动。桌面设置也已纳入共享入口检查。它们保留浏览器文件选择和画布坐标交互的语义。

`Bubble`、`Trace`、`Questionnaire` 等官方基础组件继续参与 AI 组合；密码输入和普通数值输入使用的 `InputGroup` 属于普通表单。媒体画面、分组节点、裁剪网格、蒙版、连接点和选区保持专用图形结构。没有通过更换导入目录或增加标记来计算覆盖。

排序统一经过 `SortableList`、`SortableItem`、`SortableHandle`；文件投放和画布坐标拖动使用各自的交互实现。

## 回归保护与验证

- `web/tests/architecture-boundaries.test.mjs` 扫描业务层原生表单控件（含 `fieldset` / `legend`）、重复加载图标、AI 消息和 Markdown 入口，并覆盖图标导入别名。
- `web/tests/shared-component-boundaries.test.mjs` 验证字段 ID/标签关联、元信息分离、确认框附加内容、异步关闭锁定、确认禁用和画布名称校验。
- 构建：`cd web && npm run build`；静态检查：`npm run lint`；现有回归：`bun test --timeout 20000 tests/*.test.mjs`。
- 前一轮执行结果：构建通过，Lint 为 0 错误/0 警告，188 个测试文件中的 1,389 项回归全部通过；桌面 23 项 Node 回归全部通过。桌面渲染入口另执行 `npm run build:desktop`，通过类型检查和独立构建。
- 浏览器验证使用隔离 API 数据：21 个页面/设置分区的桌面浅色和移动端深色渲染，另验证 320px 窄屏和 844×390 矮屏弹窗、触屏下拉、键盘操作、禁用状态、异步确认、AI 输入及脚本提示词。
- 截图位于 `assets/component-audit-*.png`；共享下拉和 AI 交互截图分别保留在 `assets/combobox-shared-*.png`、`assets/ai-elements-*.png`。

前一轮新增浏览器验证：42 组页面/设置分区，3 种尺寸下的确认、Skill 与局部重绘；画布起始动作、图片失败重试和音频 AI 输入，以及分享画布的错误重试、空状态、节点标题、媒体预览与键盘平移；桌面连接页的本机/远程切换、字段必填、提交去重、密码清空、失败重试与设置读取失败，覆盖 640×740、540×640、320×740、844×390。桌面页面同时在真实 Electron 的 `file://`、受限 preload 和 CSP 下加载通过。Linux root 的该项 smoke 使用 `--no-sandbox`，不视为操作系统沙箱验证；该轮未运行 Windows 实机安装包。新增截图位于 `assets/component-coverage-*.png`。

继续扫描的本次验证：

- `npm run build` 通过；`npm run lint` 扫描 650 个文件，0 错误、0 警告；`bun test --timeout 20000 tests/*.test.mjs` 的 188 个文件、1,400 项回归全部通过。构建仍有依赖已有的大分块和 `use no memo` 指令提示。
- 浏览器使用隔离 API 数据，覆盖 1440×960、320×740 触屏和 844×390 矮屏，分别验证浅色与深色。共享组件场景验证分类名称/ID 搜索、键盘选择、空结果、弹窗内焦点与 Escape、任务复制和打开隔离、Enter/Space 上传、禁用状态、键盘排序和拖动只在放下时提交。
- 真实画布页面验证菜单键盘首尾导航、Escape 焦点返回、取消重命名、菜单内 Delete 不删除节点、背景单选及键盘切换、切换项目前先保存背景、项目只激活一次，以及两类浮层在各尺寸下不越出视口。
- 本轮未修改桌面渲染入口与其共享依赖，桌面结果沿用前一轮验证；未重复运行 Windows 安装包或后端测试。截图位于 `assets/component-deeper-*.png`，运行记录位于 `/tmp/chatgpt2api-deeper-ui-*.log` 和 `/tmp/chatgpt2api-deeper-canvas-browser.log`。

参数、菜单与媒体预览的后续验证：

- 最终 `npm run build` 通过；`npm run lint` 扫描 649 个文件，0 错误、0 警告；`bun test --timeout 20000 tests/*.test.mjs` 的 187 个文件、1,404 项回归全部通过。构建仍有已有的大分块和依赖 `use no memo` 指令提示。
- 浏览器共 18 组，覆盖 1440×960、320×740 触屏、844×390 矮屏及深浅主题。参数与媒体组件验证嵌套模型 Select 不误关父层、逐层 Escape、数量更新、视口避让、滚动、外部点击、焦点返回、更多操作的键盘选择及忙碌禁用，以及视频播放、静音、下载、全屏进出和关闭按钮的空格操作。
- 真实画布页面验证右键菜单首尾导航、节点详情、复制节点、取消清空、菜单中的 Delete 隔离，以及主菜单、项目切换和背景保存；全景预览另等待真实 WebGL 画面就绪，再验证视口边界、Tab 循环、Escape、关闭按钮、焦点返回和画布快捷键隔离。
- 视频与全景使用本地生成的隔离媒体，所有 API 使用隔离数据。沿用已有 Vite 服务，没有重启开发服务；验证浏览器均已关闭。未改动后端或桌面入口，未重复执行后端与 Windows 实机检查。
- 本轮截图为 `assets/component-next-*.png`；构建、Lint、回归和浏览器记录为 `/tmp/chatgpt2api-next-ui-*.log`、`/tmp/chatgpt2api-next-{panels,canvas,panorama}-browser.log`。

引用下拉的后续验证：

- 本次 `npm run build` 通过，`npm run lint` 扫描 650 个文件，0 错误、0 警告；`bun test --timeout 20000 tests/*.test.mjs` 的 187 个文件、1,408 项回归全部通过。构建仍有已有的大分块与依赖指令提示。
- 浏览器共 36 组，覆盖三个真实编辑器组件、普通容器和 Dialog、1440×960 / 320×740 触屏 / 844×390，以及深浅主题。验证 30 个引用候选的键盘循环与滚动、Enter 不误提交、点击/触屏选择、逐层 Escape、快速失焦再输入、外部点击后的焦点、无匹配搜索和视口边界。
- 截图为 `assets/component-mention-*.png`；记录为 `/tmp/chatgpt2api-mention-{build,lint,tests,focused,browser}.log`。浏览器使用隔离组件与数据，复用现有 Vite 服务，均已关闭；本次未更改后端或桌面入口，未重新验证这些入口。

### 最终复查：页面容器、控件名称与菜单焦点

- 普通页面共用的外层 `Card` 改为布局容器，移除覆盖官方背景、圆角及卡片边框的组合；业务内容继续使用原有 Card。保留窄屏与矮屏的工作区滚动链。
- 命令面板的标题和说明放入 Dialog 内容，保留辅助技术的关联。Agent 素材菜单在动作打开弹窗时交出焦点，取消菜单仍返回原入口；共享 Dialog 将下拉菜单项的返回目标关联到持久的菜单按钮。
- 进一步验证画布右键菜单，复现了菜单立即卸载后丢失焦点来源的问题。节点详情和清空确认在打开前将焦点交给可聚焦的画布操作区，关闭后可继续键盘操作；主菜单打开的弹窗仍返回主菜单按钮。
- 通过 Chromium 可访问性树发现 10 个没有名称的控件实例：中间图数量、6 个模型能力下拉、2 个用户筛选及登录图缩放。补齐名称，并将共享 Slider 的名称、关联说明及值文本传到实际可聚焦的 Thumb，覆盖视频时长、进度、音量、裁剪和笔刷等入口。
- 矮屏登录页另复现卡片顶部被居中布局推到滚动范围之外。Viewport 改为提供明确的滚动高度，居中和内边距放到内容层；验证初始卡片顶部不裁切，标题和提交按钮均可滚动到。该检查补充了只检查横向溢出的盲区。
- 导演台的宿主已使用共享 Dialog，清理其对已删除滚动条样式的引用。`public/director/assets/` 是独立的第三方 3D 应用产物，其内部控件与 WebGL 画面保持原有实现，不计作 AI Elements 或 shadcn 的源码覆盖。
- 源码复查覆盖 `app`、共享组件与桌面入口的 229 个含 JSX 文件（158 个业务文件），保留 19 个文件输入和 4 个画布坐标操作按钮。AI 交互使用 AI Elements 组合；普通表单、导航和下拉使用 shadcn/ui；列表排序使用共享 Motion 排序组件。这些边界不以目录名称或标记数量代替验证。

本轮最终验证：

- `npm run build` 通过，`npm run lint` 扫描 649 个文件，0 错误、0 警告；187 个测试文件的 1,419 项回归全部通过。随后登录页仅调整滚动布局，另重新执行构建、Lint 与真实浏览器检查。构建保留依赖已有的分块大小和模块指令提示。
- 21 个普通页面/设置分区 × 3 种尺寸 × 2 种主题，共 126 组，通过横向溢出、字段 ID 关联和浏览器可访问性树检查，没有未命名的表单控件。另补创作台、新增/编辑素材、登录及 404 的 30 组检查，同样通过。
- 命令面板、Agent 素材菜单及真实导演台共 6 组，验证命名、键盘、禁用状态、焦点返回和关闭；分享页 3 组验证错误重试、空状态、媒体预览与键盘平移；画布菜单 6 组验证打开详情/确认后返回画布操作区，以及菜单键盘、视口边界和项目切换。
- 真实模型列表验证 40 个模型的拖动预览与让位动画，拖动期间页面 store 写入 0 次，松手后 1 次；触屏排序、键盘和保存通过。置顶导航验证拖动期间持久化写入 0 次，松手后 1 次，刷新和后续点击正常。
- 构建、Lint、回归和浏览器记录位于 `/tmp/chatgpt2api-completion-*.log`，页面截图为 `assets/component-final-pages-*.png` 与 `assets/component-completion-*.png`。使用隔离 API 数据并复用现有 Vite；未对真实账号执行写操作。
- 同期 Vite 代理检查保留当前的浏览器 Host 契约；测试使用独立临时缓存并清理，避免覆盖开发服务的依赖缓存。本轮未修改后端与桌面渲染入口，沿用前述验证，不声称重新验证 Windows 安装包。

### 补查：极矮屏确认、取消排序与有数据页面

- 在 320×390 和 390×320 下复现长说明将共享确认框操作按钮挤出可视区域。标题、说明及附加选项统一放入共享 ScrollArea，操作区保留在滚动区之外；原有忙碌关闭锁定和确认禁用语义保留。
- 通过真实触屏事件复现 `pointercancel` 仍保存临时排序。共享 SortableList 现在区分取消与正常松手，取消时恢复输入顺序且不调用保存；回归覆盖取消后再次拖动、正常提交及外部顺序变更。
- 历史记录和日志详情弹窗补齐隐藏的 DialogDescription，保留辅助技术说明关联，不增加界面可见文案；实际打开两个弹窗，验证关联目标存在且没有缺失说明的警告。
- 共享组件在 6 种尺寸与深浅主题下共 12 组验证：长说明确认框的操作可达、分页大数字、嵌套多选搜索、空结果、选项附加操作不误选择、逐层 Escape 与焦点返回。尺寸包括 320×740、844×390、1440×960、640×480、320×390 和 390×320。
- 用户、角色、日志和素材页以隔离长文本及多行数据验证，共 32 组；覆盖 4 种尺寸与深浅主题、分页、角色选择、日志详情及素材视图切换，没有文档横向溢出或未命名表单控件。
- 正常鼠标、触屏及导航排序复验通过：40 个模型拖动期间页面 store 更新 0 次，松手后 1 次；导航拖动期间持久化写入 0 次，松手后 1 次，键盘、刷新和后续点击正常。触屏取消后恢复原顺序。
- 模型选择器已拆为 CreationModelSelector；同步更新两条仍要求旧 radio 菜单的现有回归，保护搜索入口、空结果、禁用选项、图片/视频回调和选择后关闭。
- 该搜索框的自动聚焦绕过共享浮层规则，移除后进一步验证到 Tab 会离开浮层。现由触发器在展开状态下响应显式的向前 Tab，将焦点送入搜索；关闭状态和 Shift+Tab 保持原生导航。真实创作台验证打开不聚焦输入、一次 Tab 进入搜索、选择后关闭并返回触发器；新增行为回归保护这些焦点边界。
- 全量回归实际执行 188 个文件、1,422 项，全部通过；随后模型搜索焦点调整另执行共享组件、UI 交互和架构边界 3 个文件、144 项，全部通过。两次执行范围分别记录，不将此前全量结果视为新增焦点改动的全量验证。
- 本轮构建与 Lint 均通过；Lint 扫描 652 个文件，0 错误、0 警告。构建仍保留依赖已有的分块大小及模块指令提示。浏览器记录为 `/tmp/chatgpt2api-supplement-*.log`，截图为 `assets/component-supplement-*.png`；复用原有 Vite 服务，浏览器均已关闭，未对真实账号执行写操作。未改动后端或桌面入口，未重复这些入口的验证。

### 模块补查：消息、工具与等待状态（2026-11-10）

- 共享 `Tool` 保留调用方明确提供的状态文案，补齐默认停止反馈；新增 `pending` 表示尚未继续执行，与 `approval-requested` 的“等待确认”分开。停止、中断和等待状态不显示执行中的 Spinner，展开后的输入、输出仍使用共享 CodeBlock 与复制反馈。
- 创作台按服务端事件语义组合界面：`assistant` 使用 `Message` / `MessageResponse`，`tool` 使用 `Tool` / `ToolDetails`，重试等普通进度使用 Trace。仅明确的 `success` 显示完成，缺少状态的工具保持待继续；任务停止或中断后不保留运行中状态。
- 视频契约的模型正文使用 `Message`，保留模型轮次、请求次数、流式正文、错误、部分完成及中断反馈；工具格式纠正使用 Trace，只有真实工具调用使用 Tool。保留对话滚动与工具输入、输出复制。
- 画布暂停的工具与尚未生成的节点使用 `pending`，分别显示“待继续”或“待生成”；保留节点定位、失败详情、计划、终端和子任务呈现。真实权限确认继续使用 Confirmation。
- 多图工作流的提示词草稿空态、加载态分别复用 `EmptyState`、`LoadingState`，保留缺少必填项或文本模型时的禁用条件、生成回调与已有草稿。人工四步向导仍保留其表单导航语义。

本次实际验证：

- `npm run build` 通过；`npm run lint` 扫描 659 个文件，0 错误、0 警告。构建保留已有的依赖模块指令与分块大小提示。本次未修改后端或桌面入口，未重复运行 Go 测试或 Windows 实机检查。
- 新增回归先复现停止文案丢失、进度被当作工具、模型正文被当作工具及等待状态被当作权限确认，再完成修复；五个聚焦文件实际执行 193 项，192 通过、1 项为下述已有失败。另独立运行状态展示、契约进度、架构边界和 UI 交互四个文件，101 项全部通过。
- 全量前端回归实际执行 189 个文件、1,483 项：1,481 通过、2 项失败，与此前已记录的问题一致。`upstream-oct27-regressions.test.mjs` 的视频声音默认值测试缺少 `videoWorkbenchDisplayResolution` 函数依赖；`shared-component-boundaries.test.mjs` 的脚本上传测试仍从已拆分的工作区文件读取 `ScriptAssetCard`，且沿用旧上传接口。这两项未改动，不将全量结果记为通过。
- 浏览器复用现有 Vite 8002，使用隔离 API 数据及真实业务组件，覆盖 1440×960、320×740、844×390 和深浅主题。验证 Tool 等待/权限确认/停止/中断及复制；契约普通容器与 Dialog 中的模型追加、轮次、请求次数、部分完成和工具复制；创作台事件分类、回答失败保留草稿和重复提交锁；画布等待、失败详情和节点定位；工作流空态、加载态、模型与必填项禁用及已有草稿。未对真实账号执行写操作，验证浏览器均已关闭。
- 构建、Lint、聚焦、全量和浏览器日志为 `/tmp/chatgpt2api-module-fixes-*.log`；截图为 `assets/ai-elements-module-*.png`。浏览器测试脚本位于 `/tmp`，未添加测试框架或生产测试入口。

### 继续复核：视频任务卡与脚本上传回归（2026-11-10）

- 创作台视频任务卡移除自绘状态头、渐变和操作区皮肤，复用共享 `RunStatus`、`EmptyState`、`LoadingState`、`Alert`、`ScrollArea` 与 `CardFooter`。保留模型、视频序号、已用时和生成进度；排队与停止不显示运行中图标，0% 正常显示，100% 仍表示等待返回或保存视频，不提前显示成功。
- 保留终止、调整设置、重试生成与重试保存的回调及禁用条件。保存失败时仍可在空提示词下重试获取已有视频，不重新生成；长错误继续折叠，并在内部滚动区完整展示。
- 修复上一轮遗留的两项回归失败：视频声音默认值测试使用真实参数依赖，补充无显式声音选择的断言；脚本上传测试跟随已拆分的 `ScriptAssetImageDialog` 与 `CanvasScriptPromptPanel`，验证文件选择、重复选择、输入清空、禁用和关闭回调。另验证资产卡打开共享选图弹窗及生成期间锁定操作。
- 视频卡新增真实组件 SSR 回归，覆盖排队、生成、保存、失败、保存失败和停止状态；旧布局测试不再依赖已变化的 JSX 表达式。图片预览缓存测试使用独立模块实例，避免 SSR 提前导入造成会话监听初始化顺序污染。
- 对接工作区同期新增的视频 HTTPS 引用校验时，补齐现有测试提取函数的真实依赖与模型上下文；上传回调依赖当前 `videoModel`，引用 URL 过滤使用类型守卫。未改变该校验的业务规则。
- 复查消息、工具、建议、任务和脚本入口后，保留已采用官方基础组件组合的实现：画布待发送消息使用 Trace；脚本与工作流的人工步骤保持表单导航语义。没有仅为更换导入目录而套用 Queue 或 Plan。

本次实际验证：

- `npm run build` 通过；`npm run lint` 扫描 659 个文件，0 错误、0 警告。全量前端回归实际执行 189 个文件、1,487 项，全部通过；六个整合回归文件的 124 项也全部通过。构建仍有依赖已有的模块指令和分块大小提示。
- 浏览器完整执行 1440×960、320×740、844×390 与深浅主题共 6 组；每组分别验证普通容器和 Dialog 中的视频状态、0% / 100% 进度、重试与终止回调、空提示词下的重试保存、长错误折叠与内部滚动，没有文档横向溢出或页面异常。
- 脚本资产验证 Enter / Space 上传、同一文件重复选择、上传期间禁用及生成期间锁定卡片和菜单。首次脚本在窄屏键盘上传等待时超时；加入焦点和事件诊断后，单独窄屏与完整 6 组重新执行均通过，未据此改动组件行为。
- 截图为 `assets/ai-elements-continue-*.png`；最终构建、Lint、整合回归、全量回归和浏览器记录分别为 `/tmp/chatgpt2api-continue-build.log`、`/tmp/chatgpt2api-continue-lint-final.log`、`/tmp/chatgpt2api-continue-integrated.log`、`/tmp/chatgpt2api-continue-all-tests-final.log` 与 `/tmp/chatgpt2api-continue-browser-final.log`。复用现有 Vite 8002，使用隔离组件和 API 数据，浏览器均已关闭；本次未修改后端或桌面入口，未重复运行 Go 测试或 Windows 实机检查。

### 队列补查：结束状态与共享展示（2026-11-10）

- 全局任务队列的创作台结束条目原先不论成功、失败或终止都显示成功图标；队列入口也将所有刚结束的任务显示为成功。创作台活动、结束和画布任务统一复用 `RunStatus`，失败与终止分别显示相应状态；队列入口对结束记录使用中性的任务图标和“刚结束”文案，仅正在执行时显示 Spinner，纯排队使用等待图标。
- 三种条目的进度展示统一复用 `GenerationProgress`，保留原有汇总进度、数量、模型、提示词、错误、耗时以及点击后打开创作台或对应画布的回调。结束进度不作为成功状态的判断依据。
- 队列标题采用完整的 Item 组合，删除重复的自绘标题区域；列表采用共享 `ScrollArea`，浮层按可用高度约束。全局生成任务保留其导航与进度语义，没有套用表示 Agent 待办计划的 Queue。
- 浏览器使用连续长任务名复现共享 `RunStatus` 内容被撑至约 3,160px、导致列表横向溢出的问题。修复内容区的最小宽度、标题最大宽度及描述换行约束，保留共享组件样式。
- 新增五项状态和导航回归，先复现条目缺少共享状态、入口误报成功及纯排队仍显示运行图标，再完成修复。同步更新一条依赖旧素材上传说明文案的测试，核对当前提交方式说明；未修改视频契约行为。

本次实际验证：

- `npm run build` 通过；`npm run lint` 检查 659 个文件，0 错误、0 警告。全量前端回归实际执行 189 个文件、1,493 项，全部通过。构建保留依赖已有的模块指令和分块大小提示。
- 浏览器覆盖 1440×960、320×740、844×390 与深浅主题共 6 组。普通容器及父 Dialog 验证创作台排队、运行、文本完成、成功、失败、终止与画布四种状态，检查 0% / 100% 进度、长标题和错误、Enter / Space 导航回调，无横向溢出或页面异常。
- 真实全局队列另验证失败记录的中性入口、浮层可用高度、Escape 返回焦点、打开对应画布，以及 18 个活动任务的内部滚动与末项键盘操作。窄屏、矮屏均可到达最后一项，浮层没有越出视口。
- 最终记录为 `/tmp/chatgpt2api-queue-{build-final,lint-final,all-tests,browser-final}.log`，截图为 `assets/ai-elements-queue-{rows,popover,many}-*.png`。复用现有 Vite 8002，使用隔离 API 数据；验证脚本按实际 Vite 模块 URL 加载同一个 store，避免开发时的时间戳查询参数产生独立测试实例。浏览器均已关闭，没有对真实账号执行写操作。本轮未修改后端或桌面入口，未重复这些入口的验证。

### 复制交互补查：消息、提示词与数据（2026-11-10）

- 17 处普通文本复制入口统一复用现有 `CodeBlockCopyButton`：画布消息，工作流历史、当前图片提示词、运行预览和系列草稿，素材卡与文本预览，提示词市场及来源的列表和详情，日志与视频契约 JSON，渠道转换说明，分享链接、连接 ID 和节点信息。删除各页面重复的复制回调、图标及不再使用的导入；保留各入口原有尺寸、禁用条件及业务动作。
- 共享复制反馈绑定实际成功复制的内容。编辑提示词、切换图片、素材或连接 ID 后，不沿用旧值的“已复制”；旧内容的异步写入完成，也不会将当前新值标记为已复制。保留两秒反馈、错误提示、调用方取消点击及读屏实时通知。
- 共享按钮默认使用 `type="button"`，防止复制动作提交外层表单。浏览器还复现了默认 `aria-label` 覆盖文字按钮名称的问题；带文字的按钮现在保留可见文字作为读屏名称，纯图标保留默认名称，调用方明确提供的标签继续透传。
- 保留消息编辑、重试和隐藏规则，复制工作流历史不打开任务，复制市场提示词不触发套用。当前图片、已编辑草稿、契约 JSON 和渠道说明均从当前显示内容取值。Agent 素材按钮删除额外圆角覆盖，沿用共享 InputGroupButton 样式及原有菜单焦点交接。
- 全局剪贴板补查后，保留素材菜单和画布上下文菜单的原生菜单项，以及画布快捷键的节点序列化逻辑；这些不是普通复制按钮。素材媒体预览在复制失败时还会选中对应提示词并给出手动复制说明，属于共享普通复制按钮尚未提供的业务交互，本轮保留该行为。

本次实际验证：

- `npm run build` 通过；`npm run lint` 检查 659 个文件，0 错误、0 警告。共享组件、UI 交互、架构边界、渠道复制和管理页布局五个整合回归文件实际执行 197 项，全部通过。构建保留依赖已有的模块指令和分块大小提示。
- 最终全量前端回归实际执行 189 个文件、1,500 项，全部通过，记录为 `/tmp/chatgpt2api-copy-all-tests-final.log`。此前与构建及整合回归并发的一次执行有一项架构扫描超过默认五秒限制；该文件单独执行 15 项全部通过，随后全量复跑也全部通过。并发超时记录保留为 `/tmp/chatgpt2api-copy-all-tests-concurrent.log`，未为此放宽测试超时或修改扫描规则。
- 初始聚焦回归先复现工作流历史仍使用独立复制按钮，以及共享按钮缺少默认表单类型。新增行为回归覆盖编辑后的内容、延迟写入、消息编辑/重试/隐藏、图片选择、系列草稿、渠道协议示例、提示词来源详情、素材内容与连接/分享值。浏览器另复现文字按钮的读屏名称覆盖问题后完成修复。
- 两组浏览器验证均覆盖 1440×960、320×740、844×390 和深浅主题，合计 12 组。消息与工作流组验证普通容器及父 Dialog、Enter / Space、表单不提交、两秒反馈过期、剪贴板拒绝、延迟旧值、禁用和取消点击；保留编辑、重试、历史打开及素材菜单的键盘、关闭和焦点交接。
- 扩展入口组验证当前渠道地址和三种协议说明、节点信息、提示词来源列表/详情、市场复制不触发套用、完整日志 JSON、分享链接、当前连接 ID、素材卡和文本预览，以及编辑后的契约 JSON。窄屏和矮屏通过现有效果预览页签访问 JSON；全部未发现文档横向溢出或页面异常，记录到的 API 写请求为 0。
- 浏览器使用隔离 API 与剪贴板数据，复用现有 Vite 8002，没有启动额外开发服务，验证浏览器均已关闭。截图为 `assets/ai-elements-copy-*.png`；构建、Lint、整合及浏览器日志为 `/tmp/chatgpt2api-copy-{build-final,lint-final,integrated-final,browser-final,extra-browser-final}.log`。本轮未修改后端或桌面入口，未重复运行 Go 测试或 Windows 实机检查。
