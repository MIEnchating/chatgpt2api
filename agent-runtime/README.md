# 内置 Agent 执行器

使用固定版本 `@openai/agents`，由 Go 后端为每个运行启动一个 Node worker。SDK Runner 负责模型—工具循环和人工介入暂停；Go 负责身份、画布、工作流、模型中转、媒体任务和持久化。worker 仅通过私有 stdin/stdout 与父进程通信，不监听端口，不接收 API 密钥。工具、提示词和模型协议由 Go 父进程提供。

开发准备：安装 Node.js 22 或更新版本，然后在仓库根目录执行 `npm ci --prefix agent-runtime`。仍使用 `PORT=8090 go run ./internal` 和 8002 的 Vite 开发服务；不需要手动启动 worker。

- `AGENT_RUNTIME_PATH`：worker 的文件路径，默认 `agent-runtime/worker.mjs`，相对于后端工作目录。
- `AGENT_NODE_BINARY`：Node 可执行文件，默认 `node`。桌面版使用随 Electron 打包的 Node 运行环境。
- `npm test --prefix agent-runtime`：运行真实 SDK Runner 的工具循环、审批序列化与跨进程恢复测试，无外部模型请求。

运行时使用自定义 Model provider 接入 Go 的模型任务服务。长期历史和压缩后的模型输入由 Go 持久化记录提供；SDK 保存当前轮的执行和审批状态。批准提问仅允许执行返回用户答案的工具；删除工具仍由 Go 检查用户的明确确认。其他同批工具在提问时记录为未执行。

暂停状态保存在服务端控制的 `agent_run.sdkState` 中。浏览器不能通过普通画布保存替换该字段。关闭网页不影响执行；停止会结束 worker，保留已提交媒体任务。服务重启后未完成运行暂停，用户继续时恢复已保存的审批状态或根据实际检查点继续。此实现不提供多副本调度或跨服务 exactly-once 保证。

Docker 镜像包含 Node 和依赖；Linux 压缩包包含 worker、锁文件和安装说明，但不包含 `node_modules`。从压缩包目录启动前，在该目录执行 `npm ci --omit=dev --ignore-scripts --prefix agent-runtime`，并确保宿主机安装 Node.js 22 或更新版本。Windows 桌面包内含 SDK 依赖，无需用户额外安装 Node。SDK 的远程 tracing 默认关闭，执行过程记录在当前项目中，不额外上传用户内容。
