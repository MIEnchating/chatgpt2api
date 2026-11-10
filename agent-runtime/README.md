# 共享 Agent 执行器

画布、创作台智能生成、工作流创建和视频契约分析共用同一个 Node worker。LangGraph 状态图调度模型与工具循环、审批暂停和恢复；Go 提供经过身份校验的模型转发、业务工具、Session 事务、检查点和进程管理。工作流的素材依赖、媒体并发和生成任务仍由业务工具管理。

每次运行启动一个 Node worker，通过私有 stdin/stdout 与 Go 通信。worker 不监听端口，不接收 API 密钥；模型流式输出仍经过原有转发层、权限、并发及 RPM 限制和调用日志。关闭页面不会停止执行。

开发准备：安装 Node.js 22 或更新版本，在仓库根目录执行 `npm ci --prefix agent-runtime`。继续使用 `PORT=8090 go run ./internal` 与 8002 的 Vite 开发服务，无需手动启动 worker。

- `AGENT_RUNTIME_PATH`：worker 路径，默认 `agent-runtime/worker.mjs`，相对于后端工作目录。
- `AGENT_NODE_BINARY`：Node 可执行文件，默认 `node`；桌面版使用 Electron 的 Node 环境。
- `npm test --prefix agent-runtime`：使用 LangGraph 和模拟模型验证执行、Session、审批与恢复，不调用外部模型。

旧版固定依赖 OpenAI Agents SDK 0.21.0 的检查点（格式 1.23）在首次恢复时一次性转为 LangGraph 状态，先持久化迁移结果再继续。迁移核对 Session 历史前缀、工具调用与结果，保留调用 ID；待审批操作仍须有服务端记录的真实用户答案。未知格式、历史冲突、未确认的旧历史事务或输入会停止迁移并保留原记录；这类任务应在升级前完成，不能清除检查点后直接重试可能已提交的付费操作。新执行过程不加载旧 SDK。

简易流水线：在仓库根目录执行 `bash scripts/test-agent-pipeline.sh`，需要 Node.js、npm、Bun 和 Go。它安装锁定依赖，依次运行 LangGraph 模拟模型测试、前端 Lint / 全部回归 / 构建、全部 Go 包测试（包含业务工具、恢复和缓存用量传递）以及 CI 规则测试；任何阶段失败即停止。前端构建会生成 Go 所需的嵌入资源。PR CI 继续运行 race 和数据库检查。该流水线不调用付费模型或媒体服务。

## 执行与恢复

工作流与视频契约的后台记录保存在 `agent_executions/<hash>.json`，最近任务索引在独立的 `agent_execution_indexes/` 命名空间，按真实身份隔离。记录包含运行时检查点、历史事务、工具回执、领域数据及有界进度事件；HTTP 只返回状态、进度和已验收的草稿，不暴露私有输入与运行时状态。视频契约保存已读页面、证据版本、校验结果及候选页面，继续时恢复这些数据。

`/api/agent-runs` 的 GET 读取任务或指定领域的最近任务，POST 继续原 ID，DELETE 显式停止。接口按领域校验工作流权限或管理员权限。原领域的创建入口仍接受输入，用 `X-Agent-Run-ID` 保证提交确认丢失后读取同一任务；同一 ID 的不同输入被拒绝。关闭页面仅结束观察。恢复组件可重新查看后台进度和已生成草稿，停止按钮才会取消服务端任务。画布保留原项目 API 与数据路径，通过同一个执行服务运行 LangGraph。

运行时对明确可重试的模型网络故障、408、429、5xx 最多重试五次，依次延迟 1、2、3、4、5 秒，含首次请求共最多六次请求；HTTP/2 流中断也适用。400、401、用户取消、运行超时和进度保存失败不自动重试。重试只覆盖未执行工具的模型请求，不重放媒体提交。无工具的结束文字和无效 JSON 参数会交给运行时的有限纠正策略，不能直接宣布业务完成。

工具结果和领域状态保存成功后才确认执行。存储已经提交但确认响应丢失时，不再用内存旧快照覆盖已提交记录；恢复时复用原回执。进程重启后，原运行显示为中断，可从原 ID 继续。只有各领域的完成工具通过业务校验，后台记录才会成为成功状态。

运行时 Session 和序列化检查点保存在独立的 `canvas_agent_runtime/<hash>.json` 文档中，按用户、项目和会话隔离，不随浏览器画布保存提交。Session 的历史事务支持原子追加、尾部替换和 operationId 幂等确认；事务冲突不改变原记录。画布会话中的协议记录只用于展示、业务核对以及旧会话的一次性导入，不再驱动模型循环。

运行时在执行业务工具前先建立可恢复的审批检查点。普通工具由 worker 批准后交给运行时执行；提问和删除必须有对应真实用户答案，点击继续不会自动批准。用户答案与原调用 ID 一起先保存在服务端，断线后仍可交回同一个运行时调用。删除支持 `delete_node` 的单个 `nodeId` 或整批 `nodeIds`（最多 100 个，二选一），多个目标一次展示完整范围并统一确认，不逐个追问。确认后先校验整批节点内容指纹，任一目标发生变化则整批保留，不能把旧确认用于已变化的节点。

Go 工具回执与画布变更一起保存，运行时收到结果前必须完成持久化。恢复同一调用时返回已保存结果；已提交媒体使用原节点和任务 ID 接续，已完成结果直接复用；未知的写操作保留未知状态并核对，不重复创建、重新付费提交或恢复用户已删除内容。执行停止期间的画布修改也会使旧操作失效，由运行时重新核对；媒体输入变化后保留原任务，明确同意重新生成时继续使用原节点。运行时已提交检查点后可移除相应业务回执。外部 Codex 连接仍使用同一组业务工具，不能绕过内置 Agent 的待确认问题。

任务结束使用 `finish_task` 进行业务验收：计划、待处理媒体或工具错误尚未解决时返回未完成原因，由运行时继续下一轮。普通结束文字不能证明任务完成。运行时最多执行 40 个模型轮次，达到上限后保留进度和继续入口，继续时从 Session 开始新的轮次预算。服务停止、取消、上游错误和保存失败均不能记为成功。

上下文整理由 worker 通过模型网关请求摘要，保留本轮输入、引用标识、节点和任务 ID；不总结未配对的工具调用。摘要失败或必要输入超限时保留原记录。新问题不自动携带旧参考图像素，原图可通过业务工具按引用读取。

创作执行在每次模型调用前估算输入、系统指令和工具定义；达到配置的上下文上限 `contextWindowTokens` 的 80% 时整理历史，为输出与后续工具结果保留余量。默认上限为 457,000 token，对应触发点 365,600；例如 128,000 对应 102,400。`agent-runtime/context-policy.mjs` 是前端显示与运行时执行共用的比例和默认上限来源。Go 将画布保存的有效上限传给 worker，新运行及继续执行均按当前配置计算。画布会话的 `contextUsage` 公开最近一次运行时检查的 `usedTokens` 估算值、整理预算和整理状态，不包含私有输入；上游返回输入用量时另外保存 `inputTokens`，界面优先显示该实际用量，否则注明本地输入估算。估算值继续用于整理策略；上限是配置值而非中转接口返回的规格。执行记录另有 512 KB 存储限制，与模型上下文 token 限制独立，保存失败时分别说明。纯对话分支另行限制最近 6 条文本消息及单段长度，不经过创作历史整理。

旧会话首次继续时将协议历史导入运行时 Session。旧问题会重建运行时审批检查点，旧的未知操作按未知状态配对；原画布、计划、节点和媒体任务 ID 不变。导入过程不生成媒体，不自动重新提交失败媒体。此实现使用单进程项目执行锁，不提供多副本调度或跨服务 exactly-once 保证。

## 创作台智能生成

创作台的 `studio` 领域通过 `POST /api/creation-tasks/agent` 启动，使用已保存对话和轮次定位输入。历史与素材引用由服务端按当前身份读取，浏览器不能提交其他用户的对话内容。`get_history`、`get_generation_config` 和 `read_image` 提供历史、模型契约及按需图片理解；`set_generation_parameters` 调整本轮的尺寸、数量、画质、输出格式以及视频时长、清晰度、声音与契约声明的附加参数。模型和媒体类型沿用本轮选择，调整结果不改写全局默认参数。

`generate_image`、`edit_image`、`generate_video` 复用现有媒体任务和鉴权，视频工具可选择历史图片、首末帧和视频/音频引用。提交前保存原任务 ID 和参数；`get_generation_task` 等待真实结果，`finish_task` 核验任务状态后交付。恢复使用原运行 ID 和工具回执，不能重新提交已经付费的任务。单独重试某个失败结果按用户明确指定的单个结果直接生成，整轮重新生成创建新的 Agent 运行。

`ask_user_question` 暂停后通过 `/api/agent-runs?id=...` 提交 `{callId, answer}`，服务端保存并验证真实答案，普通继续不能绕过提问。执行面板显示工具过程及参数调整，允许继续中断任务。关闭页面只结束观察；显式停止取消运行及其已知媒体任务；服务重启保留媒体任务以便恢复。结果暂未写回对话时可重新读取已完成结果。

图片/视频标签以 `conversation.composerMode` 按对话保存；智能生成开关和文本模型保存在账号的 `workbench` 偏好中，在所有对话间共用。回归入口：`internal/httpapi/studio_agent_test.go`、`internal/service/studio_agent_question_test.go`、`web/tests/studio-agent.test.mjs`、创作台回归和偏好保存测试。默认测试使用模拟模型与媒体服务，不产生真实上游费用。

## 工具审计与验证范围

画布的 39 个工具使用同一份服务端 Schema；外部 Codex 调用同一套业务实现。工具按当前业务范围核对，不提供任意命令执行、任意网络访问或绕过媒体授权的入口。

| 能力 | 工具 | 业务检查与回归 |
| --- | --- | --- |
| 节点与引用读取 | `get_canvas_summary`、`query_canvas_nodes`、`get_selected_nodes`、`get_node`、`list_references`、`get_reference`、`get_upstream_nodes`、`get_downstream_nodes`、`get_connected_nodes` | 所属画布、分页、已删除引用、原图按需读取；`canvas_agent_context_test.go`、`canvas_agent_tools_test.go`、`canvas_agent_reference_resume_test.go` |
| 配置与任务状态 | `get_generation_config`、`get_generation_task`、`get_media_task_status` | 读取真实节点与任务，保留已提交任务；`canvas_agent_test.go`、`canvas_agent_sdk_store_test.go` |
| 计划、状态、Skill | `update_plan`、`set_agent_state`、`read_skill_file` | 计划 ID 与状态、真实节点引用、仅允许已选 Skill；`canvas_agent_runtime_test.go`、`canvas_agent_tools_test.go` |
| 用户交互与验收 | `ask_user_question`、`delete_node`、`finish_task` | 真实用户回答、删除指纹、计划与媒体完成检查；`canvas_agent_test.go`、`canvas_agent_concurrency_test.go`、`canvas_agent_sdk_store_test.go` |
| 内容编辑 | `create_primary_script_node`、`create_script_node`、`update_script_node`、`create_text_node`、`update_text_node`、`update_node` | 原位编辑、脚本引用、显式 false 与清空、忙碌节点拒绝修改；`canvas_agent_scripts_test.go`、`canvas_agent_node_edit_test.go` |
| 连线与布局 | `create_connection`、`delete_connection`、`create_group`、`arrange_nodes` | 连线去重、分组成员、整理授权；`canvas_agent_tools_test.go` |
| 媒体生成 | `generate_image`、`edit_image`、`generate_video`、`generate_audio`、`generate_node` | 模型参数、参考类型、授权、已有任务复用和失败后明确重试；`canvas_agent_test.go`、`canvas_agent_parallel_test.go`、`canvas_agent_empty_media_test.go` |
| 工作流 | `list_workflows`、`get_workflow`、`save_workflow`、`run_saved_workflow`、`create_canvas_workflow`、`run_canvas_workflow` | 所有权、revision、变量契约、依赖顺序、循环拒绝、系列提示词审核；`canvas_agent_workflows_test.go`、`canvas_agent_external_tools_test.go`、`canvas_agent_test.go` |

本次补齐 `save_workflow` 的 text、textarea、number、select、boolean 变量类型、选项和占位文本；原位更新保留变量 ID 以及省略的默认值、类型、选项和占位文本，显式空值用于清除。工作流草稿 Agent 的 `submit_workflow` 仅交付服务端校验后的草稿，不直接应用模板或生成媒体。视频契约 Agent 的 `inspect_protocols`、`read_documents`、`validate_contracts`、`finish` 依次提供协议目录、候选文档读取、实际请求构造校验和已验证结果交付；文档缓存与证据版本、失败页重读及校验失效见 `internal/httpapi/video_contract_agent_test.go`。

## 故障恢复回归

执行面板按当前请求计算等待状态；本轮验收通过后，历史素材错误仍保留在原节点，不作为本轮任务失败。`finish_task` 因计划未完成被拒绝、随后在同一任务内通过时，旧核验显示“已修正”并保留原始错误详情；其他任务的成功不能消除旧任务错误。计划进度将暂缓步骤单列，不计入当前待完成步骤。脚本已关联全部目标媒体节点时，手动继续使用原节点配置，不要求重新合成脚本提示词或为额外道具补图。

已有节点通过 `update_node` 原位编辑标题、提示词、类型对应的生成参数及来源引用：视频可修改比例、分辨率、时长、声音和首帧/多模态参考模式，图片可修改尺寸、画质和数量，音频可修改声音、格式和语速。只更新提供的字段，`false` 与空来源列表均保留显式语义；保留节点 ID、脚本绑定、旧媒体和任务，生成中的节点拒绝编辑。编辑只保存，后续生成走原 `generate_node` 及用户确认链路；失败任务需明确重试，成品修改输入后也不能直接把旧结果当作新交付。只有用户要求独立版本或副本时才创建新节点。

公开会话保留可见消息与工具日志，私有运行时存储保留完整 Responses 数据。已有私有记录时，启动及保存进度会移除公开历史中较早的原始回复和不透明推理副本；重新打开画布也会在会话接近上限且无运行中的 worker 时进行清理，避免重复数据撑满 512 KB 公开会话上限；最新尚未提交运行时的回复保留，实际模型历史与私有检查点不变。

原生脚本通过 `create_primary_script_node` / `create_script_node` 创建，通过 `update_script_node` 保存结构化镜头、资产和提示词；已有文本主稿可原位转为脚本，保留节点 ID、正文及连线。`get_node` 返回 `scriptProject`，轻量索引不展开完整脚本。镜头可通过 `source_node_id` 记录原文本，通过 `image_node_id` / `video_node_id` 关联已有媒体；资产用 `image_node_id` 复用参考图。省略关联字段会保留同一镜头或资产的旧关联，显式空字符串用于解除关联。整理不自动删除来源文本、不改媒体参数或提交任务。脚本面板先保存镜头关联，再为缺少素材的镜头创建节点；已完成素材复用，已有任务按原 ID 恢复，失败的付费任务留在原节点供用户明确重试。

| 场景 | 必须保持的行为 | 回归入口 |
| --- | --- | --- |
| 页面断开与显式停止 | 断开仅取消观察；显式停止取消上游请求 | `internal/httpapi/agent_execution_test.go`、`canvas_agent_test.go` |
| 服务停止与数据库重新打开 | 使用原运行 ID、Session 和工具回执继续 | `internal/service/agent_execution_test.go`，包含 SQLite、MySQL、PostgreSQL |
| HTTP/2 流中断与 HTTP 400 | 流中断由运行时有限重试；400 保留检查点，不重复请求 | `agent-runtime/test/worker.test.mjs`、`internal/service/agent_runtime_test.go` |
| 工具已提交但确认丢失 | 不覆盖已提交记录，恢复时复用原结果 | `internal/service/agent_execution_test.go`、`canvas_agent_sdk_store_test.go` |
| 等待用户回答 | 继续不能代替真实回答或自动批准删除 | `agent-runtime/test/worker.test.mjs`、`internal/service/canvas_agent_test.go` |
| 暂停期间修改节点 | 保留用户修改，旧审批失效，不重提已付费媒体 | `internal/service/canvas_agent_sdk_store_test.go`、`canvas_agent_concurrency_test.go` |
| 上下文或轮次超限 | 保留原输入和进度；轮次耗尽可继续且不重复原输入 | `internal/service/agent_execution_test.go`、`agent-runtime/test/worker.test.mjs` |

## 提示词缓存

画布的固定规则及本次选用的 Skills 在一次 worker 运行中保持不变，Skill 附属文件按路径排序。实时画布快照作为带资料说明的 user 消息追加到私有模型投影，不再放在 system 消息中，避免上游 Chat → Responses 转换将动态快照提升到 instructions、改写缓存前缀。相同快照不重复追加；变化的快照保留在原位置，后续轮次追加模型输出、工具结果与新快照，保持上一轮完整请求的前缀。参数纠正反馈也不追加为 system 消息。快照不是用户的新操作授权。

模型投影及对应的权威历史边界保存到私有检查点，重启继续时沿用旧前缀并追加最新状态，不写入公开会话或权威 Session 的用户消息。快照计入上下文预算；整理时保留真实用户请求与最新快照，旧快照不进入摘要，避免把自动状态消息当成新的用户要求。达到预算、视觉窗口变化、新任务或修改模型与规则仍可能导致缓存重新预热。

共享 worker 从服务端提供的、已按身份隔离的 sessionId 派生稳定的 prompt_cache_key，同一会话的工具轮次、网络重试和重启继续使用同一个标识，不依赖 run ID 或每次请求的随机值；摘要使用独立的稳定标识。画布、工作流创建和视频契约分析均将此标识透传到 Chat / Responses 上游。键中不包含原始用户、项目、会话标识或密钥。流式 Chat 请求显式启用 stream_options.include_usage，保留上游实际返回的缓存读取及写入统计；未返回统计不视为零命中，也不推算缓存用量。

缓存由上游模型服务决定，稳定标识与前缀不保证每次命中；账号或渠道切换、缓存预热和过期也影响结果。默认回归使用模拟模型验证完整请求前缀、实时状态、预算限制、重启恢复、会话隔离及 Chat / Responses 缓存参数和用量透传，不调用付费模型。真实上游验证应使用少量隔离文本请求，不重放用户大上下文或媒体任务。

## 打包

Docker 和桌面包必须包含 `agent-runtime` 下全部 `.mjs` 模块与运行时依赖。Linux 压缩包包含模块、锁文件与说明，不包含 `node_modules`：启动前执行 `npm ci --omit=dev --ignore-scripts --prefix agent-runtime` 并安装 Node.js 22 或更新版本。Windows 桌面包内含依赖和运行环境。
