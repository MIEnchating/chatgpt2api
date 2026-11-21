# 创作任务的 SSE 订阅

## 前端公共入口

- `web/src/lib/server-sent-events.ts`：解析 SSE 的 UTF-8 分块、多行 `data`、换行边界与心跳注释；统一管理取消、空闲超时和单条事件大小。
- `web/src/lib/request.ts` 的 `httpRequestEventStream`：复用站内请求的 Cookie、错误响应和未授权处理，支持 GET 与 POST。文档契约分析也使用此入口。
- `web/src/lib/creation-task-events.ts` 的 `watchCreationTasks` 订阅指定工作流批次，`waitForCreationTask` 等待指定任务的终态，并通过 `onProgress` 接收中间结果。

同一页面中的多个任务共用一条连接。浏览器合并同一轮提交的任务和批次。新增订阅超出当前范围时，浏览器以新的范围重开连接，最后一个订阅释放后关闭连接。账号变化时清空连接和缓存。临时断线采用退避重连，重新接收当前订阅范围的快照。取消订阅只停止接收，停止服务端任务仍调用原有 cancel 接口。

画布文字及媒体任务、画布 Agent 模型请求、工作流任务等待和恢复已使用公共订阅。任务历史的首次加载仍可以使用 GET `/api/creation-tasks`。页面上的本地计时和恢复截止时间不发送网络请求。

本地 Codex 使用自己的 loopback 地址与 Bearer 密钥，不携带站内 Cookie；它复用相同的 SSE 解析器。

## 后端协议

`POST /api/creation-tasks/events` 使用现有创作任务读取权限，只返回当前身份拥有的公开任务字段。JSON 请求体包含 `task_ids` 和 `workflow_batch_ids` 两个字符串数组，至少有一个 ID。工作流批次包含之后创建的子任务。

首次连接发送 `data: {"type":"snapshot","items":[...],"deleted_ids":[...]}`，其中包括范围内已结束的任务，以及指定任务 ID 对应的现存删除记录。之后发送 `type: "tasks"` 的变更集合。任务沿用 `revision`、`status` 与 `data` 结构，文字中间结果是累计的 `data[].text_response`。删除记录通过 `deleted_ids` 推送。每 15 秒发送一次 SSE 注释心跳。

任务服务在创建、文本片段、媒体进度、取消、完成和删除时通知订阅者。通知合并为最新状态，不为慢客户端无限堆积队列。浏览器断线不会取消持久化任务，重连可恢复最终结果。

多实例之间继续使用既有的共享存储同步机制。本实例产生的中间文本即时推送；未持久化的文本或图片预览不会跨实例同步，最终状态可从共享存储恢复。
