# Go 后端开发规范

遵守根目录规范。路径相对于 `internal/`；涉及上游协议时先读 [协议研究](../.agents/rules/protocol-research.md)。

- 依赖方向保持 transport → application → persistence：`httpapi` 管路由、鉴权、解析和响应，`service` 管业务流程，`storage` 管持久化，`protocol` 管上游契约与客户端。
- HTTP handler 按业务域拆分，不向共享路由文件堆入无关功能。管理员异步任务统一以 `/api/creation-tasks` 为根，子资源使用 `image-generations`、`image-edits`、`chat-completions`；不得增加 image 命名的任务别名或把 chat 放到图像资源下。
- Go 使用 `gofmt`，包名短小、小写且表达领域；测试放在代码旁的 `*_test.go`，命名如 `TestCreationTask...`。
- 以仓库 `go.mod` 为版本基线，适用时使用 `any`、`strings.Cut`、`slices` 等标准库能力；不因风格调整改变零值、nil、并发或计费语义。
- 可选中转标量区分缺失与显式 `0` / `false`，避免非指针 `omitempty` 丢弃客户端意图；优先复用现有协议类型和序列化约定。
- 服务、配置、路由及协议行为修改补聚焦回归，优先扩展已有文件，不沿调用链逐层复制测试。数据库变化验证相关存储路径及升级行为，使用隔离实例。
- 前端嵌入资源存在后，从仓库根目录运行相关包测试或必要的 `go test ./...`；`go build -tags=embed -o chatgpt2api ./internal` 仅作发布/构建验证。
