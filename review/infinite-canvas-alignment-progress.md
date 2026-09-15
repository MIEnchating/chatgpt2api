# 无限画布对齐执行记录

目标：根据 2026-09-15 对比记录，补齐功能和修复同类问题，保持 Go/Vite、Cookie 鉴权、统一存储与创作任务合同。

基准：上游 `f30b8d7`；本地 `5fd0adb` 加任务开始时已有的工作区修改。原有修改保留，未提交、未发布。

用户确认：全部外部接入和 Windows 桌面端分阶段纳入；默认手动生成；分组即标签，保留历史分组/标签，以现有分组关系作为唯一标签体系；保留工作区供检查。

| 工作项 | 状态 | 完成证据 |
| --- | --- | --- |
| 自身图片与连线参考合并、引用编号 | 已完成 | 实际 helper 与请求回归测试 |
| 视频失选暂停、焦点快捷键、平移 | 已完成 | 浏览器验证失选暂停、视频焦点下复制/粘贴/删除；平移定向测试 |
| 输入框换行和引用光标 | 已完成 | contenteditable 与 Agent 定向测试 |
| Agent 严格工具校验、一次纠错、截断保护 | 已完成 | 协议及 runtime 行为测试 |
| Agent 长记忆、大画布分页查询 | 已完成 | 64k 输入预算、完整轮次摘要、查第 250 个节点的行为测试 |
| 个人/系统 Skill 管理、选择、附属文件 | 已完成 | 身份隔离、管理员权限、CAS/revision、体积/路径校验；浏览器创建、编辑、选择 |
| 默认手动生成、Chat/Responses、深入思考 | 已完成 | 4 类媒体动作手动/自动矩阵；浏览器默认值及 Responses/思考设置保存；HTTP 协议测试 |
| Agent 消息复制、改名、节点定位 | 已完成 | 全量前端回归；新对话清空 Skill、首页选择继承 |
| 视频截帧、分离音频、音频截取、节点进度 | 已完成 | 媒体定向测试；浏览器真实 MP4 首帧、音轨提取、截取与试听起点验证 |
| 分组树与折叠 | 已完成 | 树结构测试；浏览器折叠/展开验证 |
| 素材统一标签、URL 元数据、编辑保留归属 | 已完成 | 分组关系迁移、同名合并、过滤、取消/身份切换元数据测试 |
| WebDAV MP4 扩展名 | 已完成 | 内存 WebDAV 实际上传测试 |
| 无引用文件回收、撤销保护与失败重试 | 已完成 | 持久队列、24h 宽限、历史租约、运行任务/CAS 并发、跨域引用；浏览器保存租约 |
| 公开存储 URL 引用保护 | 已完成 | 无 storageKey 的公网 URL、Markdown/工具结果与历史租约保护；写入租约阻止并发删除 |
| 远程图片参考 URL 复用 | 已完成 | Chat/Responses 混合有序 URL/文件；私有地址、Images/遮罩边界测试 |
| Codex 本地桥、画布连接、MCP | 已完成并复核 | 当前 CLI schema、Node 14 项、前端 10 项；真实初始化/账号/模型读取；未发送模型 turn |
| Codex 插件与连接 Skill | 已完成 | 插件/Skill 格式验证、真实 CLI plugin/read 识别、按插件 MCP 配置启动及初始化；未安装/发布 |
| MCP 媒体提交即返回 | 已完成 | 服务端提交确认后返回任务 ID，后台轮询继续；真实 handler 模拟长任务测试 |
| AutoDL 视频/音频 | 已完成 | 真实公开目录/规则读取、元数据缓存、规则与任务测试、视频契约导入、画布参数 |
| 方舟原生标准 / Agent Plan | 已完成 | 独立驱动、typed content/role、路径与结果转换的 HTTP 模拟测试 |
| Windows 桌面客户端 | 代码、交互验证和安装包已完成 | Electron 本地/远程模式、内置 Go、账户引导、stdin 退出、实例健康检查、独立会话、安全 IPC、退出/切换/刷新前保存；实机验证见下文边界 |
| 文档与最终检查 | 已完成 | 使用文档、协议证据、截图、Windows 产物与校验均已保存 |

## 验证记录

- 最终完整前端：`npm run test`，955 项通过、0 失败，131 个文件；`npm run build` 和 `npm run lint` 通过。
- Codex Node 桥/MCP 14 项通过，前端 SSE/hook 10 项通过。独立复核发现并修正旧 turn 事件污染、文件审批缺少 diff、停止后工具队列阻塞；MCP 长媒体任务已改为提交即返回。
- 最终 `go test ./...` 全部通过，包括 AutoDL 依赖方向架构检查，以及文件引用、租约和非标准 IPv4 校验修复。service 通过接口接入 protocol 客户端，没有放宽架构测试。
- Linux `go build -tags=embed` 通过，验证产物未作为开发服务运行，检查后已删除。
- Codex 插件通过 `validate_plugin.py`、连接 Skill 通过 `quick_validate.py`；真实 CLI 0.154.0 的 `plugin/read` 识别 Skill/MCP，按 `.mcp.json` 的命令、相对工作目录和环境配置启动 MCP 并完成 initialize。临时市场目录和子进程已清理，没有安装到用户市场。
- 桌面最终 20 项单元测试通过；真实 Linux Electron 验证开发服务复用、连接菜单、切远程/本机、独立 Cookie、IPC 来源、非法 popup 拒绝、隐藏模式表单，以及切换/返回/重新加载前等待保存、失败保留窗口交互；另验证单实例锁。临时 Wine、Xvfb、Electron 和 HTTP fixture 进程均已清理。
- 浏览器复用原 Vite 8002，临时 Go 源码 8090 使用隔离目录 `/tmp/chatgpt2api-alignment-ui-z9idmihu`。浏览器均已关闭；核对 PID、目录、端口和 cgroup 后已停止本任务的临时 Go 服务，原 Vite 8002 保留。
- 浏览器成功项：Skill 新建/编辑/选择，分组折叠，视频失选暂停、focus 复制/粘贴/删除，首帧截取，音轨分离，音频范围试听/截取，Agent 手动默认值、Responses/深入思考配置持久化，撤销文件租约保存。无 pageerror。
- 截图目录：`review/screenshots/infinite-canvas-alignment/`。

Windows 本地构建产物（不提交、不发布）：

- [NSIS 安装包](../desktop/dist/chatgpt2api-3.0.13-windows-x64-setup.exe)：121,736,493 字节，约 117 MiB。
- [SHA-256 校验文件](../desktop/dist/chatgpt2api-3.0.13-windows-x64-setup.exe.sha256)：`f90d083c4fe153d7532c753982a3f600e4597e26cbe1f27b822e2606b1ff5417`，已重新校验通过。
- `7zz t` 安装包完整性通过；最终 `app.asar` 与桌面源码一致，内置 Go EXE 与最终交叉编译结果一致。详细机器记录在 [verification.json](../desktop/dist/verification.json)。

收尾独立复核还修正了以下可复现问题：

- 公开存储 URL 末尾的合法标点和 Markdown 包裹不能导致引用丢失；正文里类似文件路径的文字只作为候选，不再阻止纯文本画布保存，真实媒体引用仍严格校验。
- 已过期的撤销租约不能被保存请求续期；休眠期间的异步生成完成后，也不能通过旧闭包重新装回已释放的历史。
- 服务端拒绝短 IPv4、八进制、十六进制及 Unicode 归一化后的私网别名；纯 URL 拒绝测试不再被无关上传校验掩盖。
- 桌面退出、关闭主窗口和切换连接前等待当前画布及后续编辑保存，失败或超时保留窗口；初始密码按 bcrypt 的 72 UTF-8 字节上限校验。

## 配置与实际验证边界

使用方式见 [功能与接入说明](../docs/canvas-alignment.md)、[Codex/MCP](../canvas-agent/README.md)、[Windows 桌面](../docs/windows-desktop.md)。

- AutoDL 已读取公开元数据，没有付费生成；方舟为 httptest 协议验证。账号权限、额度、外部下载和部署参考 URL 可达性仍需在实际配置下验证。
- Codex 实际验证限初始化、账号、模型列表和插件读取，未发起付费 turn。dynamicTools 使用 CLI 0.154.0 experimental schema，升级 CLI 后需校验。插件源码已具备，连接密钥/ID按文档从本机环境传入，未做公共市场发布或自动跨浏览器登录。
- 文件回收覆盖统一 `/api/files`；旧专属媒体目录仍按既有策略治理。Direct WebDAV 只回收索引。失联浏览器超过租约后不再保留旧撤销历史。
- Windows 安装包未签名；安装、首次启动与实际系统权限尚未在 Windows 实机验收，Linux 构建与测试不能替代此项。Linux root smoke 使用了仅限该测试进程的 `--no-sandbox`，产品配置仍启用沙箱，这次测试不证明操作系统沙箱行为。
- 按功能和协议自主实现，未复制上游 AGPL 变更后的新代码；历史来源许可见原对比记录。
