# 项目架构与依赖边界

本项目参考 `tigerowo/infinite-canvas` 的职责分层，并按当前 Go/Vite 单体的真实依赖映射为：

| 本项目 | 职责 | 可依赖的内部层 |
| --- | --- | --- |
| `internal/model` | 跨配置、存储和服务共享的持久化数据模型 | 无 |
| `internal/util` | 无业务所有权的叶子工具 | 无 |
| `internal/protocol` | 无状态的上游请求合同、厂家传输驱动和结果归一化 | `util` |
| `internal/storage` | SQLite/PostgreSQL/MySQL 持久化与并发控制 | `model` |
| `internal/config` | 环境变量、在线配置、存储后端装配和敏感配置边界 | `model`、`storage`、`util` |
| `internal/service` | 账号、任务、画布、工作流、素材和对象存储等业务规则 | `model`、`storage`、`util` |
| `internal/videocontract` | 视频模型契约的草稿、版本、发布、持久化和运行时注册 | `protocol`、`storage`、`util` |
| `internal/httpapi` | 路由、Cookie 鉴权、RBAC、请求解码、应用编排和 HTTP 响应 | 上述应用与基础层 |
| `internal/web` | 嵌入已构建的前端静态文件 | 无 |

`internal/main.go` 是组合根，只负责启动和关闭 `httpapi`。前端依赖由低到高为 `lib -> services -> store -> components -> app`：页面负责交互编排，`services` 保存后端请求与持久化适配，`store` 保存共享状态，`components` 提供可复用 UI，`lib` 保存底层合同与通用逻辑。低层不得反向导入高层。

## 强制边界

- `model`、`util` 和 `web` 不依赖其他内部包。
- `storage` 不依赖 `config`、`service`、`protocol`、`videocontract` 或 `httpapi`。
- `service` 不依赖 `config`、`protocol`、`videocontract` 或 `httpapi`。
- `protocol` 不依赖 `config`、`storage`、`service`、`videocontract` 或 `httpapi`。
- `videocontract` 不依赖 `config`、`service` 或 `httpapi`。
- 对象所有权、容量限制、任务状态等业务规则位于 service；HTTP 层只传递身份、校验传输格式和映射错误。
- 前端每一层只能导入自身或更低层。

上述方向分别由 `internal/architecture_test.go` 和 `web/tests/architecture-boundaries.test.mjs` 持续验证。
