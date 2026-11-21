# AIGASAPI 视频接入

1. 在创作台的 **设置 → 视频模型契约 → 导入 JSON** 选择 [contract.json](contract.json)，导入一份启用的契约。
2. 在 New API 的插件管理上传并启用 [aigasapi-video-2.0.3.js](aigasapi-video-2.0.3.js)，创建 **任务插件** 渠道，绑定 `aigasapi-video`。
3. 渠道 Base URL 填 `https://www.aigasapi.com`，渠道 Key 填 AIGASAPI Key。在渠道获取模型，或按 [model-mapping.json](model-mapping.json) 的键添加所需模型，设置分组、令牌权限及售价。
4. 创作台线路填 New API 的 Base URL 和该网关的令牌，选择 `video-` 开头的模型。

插件内置模型映射，向 AIGASAPI 发送原样 ID。模型发现用渠道 Key 请求 `GET /v1/models`，只返回与当前账号可用列表精确匹配的契约别名。两条仅大小写有区别的 Flash 型号分别为 `video-sd-2.5-flash-720p`（按秒）和 `video-sd-2.5-flash-720p-per-request`（按次）。[模型目录](https://www.aigasapi.com/pricing)

从 1.0.0 升级时，在现有渠道重新获取并保存模型，将关联定价、令牌白名单及客户端模型 ID 切换到 `video-`，并在创作台更新原有契约。公开渠道名称可使用「视频模型」。

## 协议和范围

- 创建使用 `POST /v1/videos`，查询使用 `GET /v1/videos/{id}`，均通过渠道 Bearer Key 鉴权。插件在宿主任务 ID 前加 `video_` 作为 `out_task_id`，避开上游保留的 `task_` 前缀，同一网关任务重试复用该值。完成后查询 `metadata.url`，由 New API 无凭据下载 HTTPS 视频，创作台通过 New API 的 `/v1/videos/{id}/content` 获取结果。[视频接口](https://www.aigasapi.com/docs/api/videos)
- 创作台传入的首尾帧或参考素材 URL 会转换为 AIGASAPI 的 `references[]`，并带上素材类型和角色。这里开放公网 HTTP(S) URL、单独的首尾帧模式和普通参考模式。AIGASAPI 的文件预上传、素材字节数检查和首尾帧与非图素材混用未接入。[视频接口](https://www.aigasapi.com/docs/api/videos) · [文件上传](https://www.aigasapi.com/docs/api/uploads)
- 依据 2026-11-22 读取的公开结构化目录，纳入 42 个同时声明 `openai-video`、视频能力和按秒或按次计费的模型。仅声明 `openai` 的视频型号与缺少结构化能力的 `sd-2.5-官方版-1080p` 暂未纳入。[公开目录](https://www.aigasapi.com/api/pricing)
- 目录缺少可选分辨率时省略 `resolution`。`video-minimax-h3-official-768p` 的上游型号和描述标注 768p，结构化目录写为 720p。线上传入 720p 和省略分辨率的两次任务均在上游失败。2.0.3 按 MiniMax H3 原生接口的写法显式发送 `768P`，该值在 AIGASAPI 渠道的实测结果待确认。升级时同步更新创作台契约。现有按秒售价只依赖 `seconds`。[公开目录](https://www.aigasapi.com/api/pricing) · [MiniMax H3 接口](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)
- 创作台默认 5 秒和 16:9，模型不支持时使用该模型的第一个可选值。按秒模型报告请求秒数，按次模型报告 `count: 1`。售价由 New API 配置。

## 复现和验证

```bash
bun integrations/newapi/aigasapi/build.mjs
node --test integrations/newapi/aigasapi/plugin.test.mjs
go test ./internal/httpapi -run '^TestAIGASAPIVideoContractImportsAndMapsFrames$' -count=1
new-api plugin lint integrations/newapi/aigasapi/aigasapi-video-2.0.3.js
```

构建使用目录快照，并生成契约、模型映射、干跑结果和单文件插件。现有 New API 宿主需支持插件 API v1 的按模型用量配置和模型发现钩子。验证使用模拟上游，AIGASAPI 账号权限、实际扣费和视频产出需在配置渠道后验证。
