# Dramaya Wan 3 视频契约与 New API 插件

模型 ID 为 `wan-3`，插件标识为 `dramaya-wan-3`，版本 `1.0.0`。参数依据用户于 2026-11-06 提供的当前模型 schema；创建、查询、状态与下载依据同日读取的 [Dramaya 视频文档](https://playground.dramaya.us/developers#videos)。公开文档未单独列出 `wan-3`，是否可调用仍以渠道 Key 的模型目录为准。

## 导入与安装

1. 在本项目“设置 → 视频模型契约”中导入 `contract.json`（格式版本 4）。
2. 在 New API 插件管理中上传 `dramaya-wan-3-1.0.0.js` 并激活，创建“任务插件”渠道，绑定 `dramaya-wan-3`。
3. 渠道 Base URL 填写 `https://video.dramaya.us`，不追加 `/v1`；渠道中填写 Dramaya Key，模型填写 `wan-3`。插件文件不含 Key。
4. 在 New API 配置分组、令牌的模型权限及售价。插件仅报告请求秒数和清晰度，不包含价格。
5. 创作台使用 New API 地址、New API 令牌及导入的契约。实际创建、查询与下载地址由所配置的中转服务决定。

`plugin-options.json` 保存生成器配置；插件由仓库现有 `GenerateNewAPIVideoPlugin` 生成，Go 回归会核对生成结果与交付文件一致。导入契约不会自动安装 New API 插件。

## 请求契约

| 字段 | 默认值 | 可选值 |
| --- | --- | --- |
| `model` | 必填 | `wan-3` |
| `prompt` | 必填 | 非空字符串 |
| `duration` | `5` | 数字 `5`、`10`、`15` |
| `resolution` | `480p` | `480p`、`720p`、`1080p` |

```json
{
  "model": "wan-3",
  "prompt": "镜头缓慢推进，云朵掠过山顶",
  "duration": 5,
  "resolution": "480p"
}
```

只接受文生视频 JSON 请求。用户提供的 `references: {}` 未声明任何素材能力，因此契约没有图片、视频、音频或首尾帧输入。参数的 `modes: ["generation", "edit"]` 表示参数可见范围，不能据此推导视频编辑接口。没有声明画幅、音频开关、水印或随机种子，不额外发送；也不转换 `seconds`、`size` 等别名。非法时长、清晰度、未声明字段及文件上传会被拒绝。

## 创建、查询与下载

- 创建：`POST /v1/videos`；上游使用渠道 Bearer Key。
- 查询：`GET /v1/videos/{id}`；插件使用上游任务 ID，客户端使用 New API 返回的公共任务 ID。
- 下载：客户端访问 New API 的 `GET/HEAD /v1/videos/{id}/content`。插件先使用渠道 Key 查询最新结果，再从 `video_url` 或 `data[0].url` 取得签名地址，以 `credentialless: true` 下载，不向 CDN 发送 Key，不复用旧签名地址。
- 创作台契约使用 `task_content` 加中转鉴权，以取得 New API 宿主提供的视频内容；插件上游下载配置使用 `signed_url`。这两项分别描述创作台到中转、插件到供应商的请求。
- `queued` 等待，`running/in_progress/processing/pending/cancel_requested` 继续轮询，`completed` 成功，`failed/cancelled/expired` 终止失败；未知状态返回 `UNKNOWN`。进度 100% 不代替完成状态。
- 契约轮询间隔 5 秒、超时 900 秒是客户端配置；New API 的任务调度遵循宿主配置。插件没有取消接口，也不生成或透传幂等请求头；收到任务 ID 后继续查询，避免重新创建任务。

## 本地验证

```bash
go test ./internal/videocontract -run '^TestDramayaWan3PluginArtifact$' -count=1
node --test integrations/newapi/dramaya-wan-3/plugin.test.mjs
```

覆盖契约结构与代表性请求、生成文件一致性、全部 9 组时长和清晰度组合、默认值、非法参数拒绝、任务状态、GET/HEAD 下载刷新及凭据隔离。`contract-dry-run.json` 与 `plugin-dry-run.json` 为本次本地干跑结果。

2026-11-06 已使用本地 New API 自身的 `pkg/jsplugin` 运行时重放交付插件，12/12 项通过；样本包含全部 9 组参数组合、协议解码、用量提取和拒绝请求字段 `seconds`。出站请求使用 `duration`，用量中的 `seconds` 不进入请求体。可用 `new-api plugin test dramaya-wan-3-1.0.0.js --fixture newapi-host-fixture.json` 重放；源码版本与结果见 `newapi-host-validation.json`。

契约已导入当前创作台服务。用户已在 New API 激活插件，但线上任务仍报告 `unsupported published model parameter "seconds"`；本地 HTTP 链路及插件运行时回放未复现该错误，尚待核对线上上游请求与任务响应。上述验证没有调用付费生成接口，不代表线上故障已修复。
