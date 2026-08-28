# 项目架构与依赖边界

本项目参考 `tigerowo/infinite-canvas` 的 `handler -> service -> repository -> model` 分层，并按现有 Go/Vite 技术栈映射为：

| 参考项目 | 本项目 | 职责 |
| --- | --- | --- |
| `handler` / `router` | `internal/httpapi` | 路由、Cookie 鉴权、RBAC、请求解码和 HTTP 响应 |
| AI handler 与 service 编排 | `internal/protocol` | 上游协议合同、生成执行编排和结果归一化 |
| `service` | `internal/service` | 账号、任务、画布、工作流、素材和存储等业务规则 |
| `repository` | `internal/storage` | SQLite/PostgreSQL/MySQL 持久化与并发控制 |
| `model` | `internal/model` | 跨 service/storage 共享的持久化模型 |

前端按 `app/components -> store -> services/api -> lib` 组织。页面负责交互编排，`services/api` 保存后端请求合同，`lib` 保存与页面无关的纯逻辑。共享层不得反向导入 `app` 页面模块。

## 强制边界

- `model` 不依赖其他内部包。
- `storage` 不依赖 `service`、`protocol` 或 `httpapi`。
- `service` 不依赖 `protocol` 或 `httpapi`。
- `protocol` 不依赖 `httpapi`。
- 对象所有权、容量限制、任务状态等业务规则位于 service；HTTP 层只传递身份、校验传输格式和映射错误。
- 前端 `lib` 与 `services` 不导入 `app`。

上述方向分别由 `internal/architecture_test.go` 和 `web/tests/architecture-boundaries.test.mjs` 持续验证。
