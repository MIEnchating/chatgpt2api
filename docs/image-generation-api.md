# 内部生图任务文档

本文档描述 Web 创作台、无限画布和工作流使用的登录态内部图片任务接口：

- `POST /api/creation-tasks/image-generations`
- `POST /api/creation-tasks/image-edits`
- `GET /api/creation-tasks` 与任务取消接口

本项目不提供面向第三方的 OpenAI 兼容 API，也不签发个人 API Key；本地 `/v1/images/generations`、`/v1/images/edits`、`/v1/models` 及其他 `/v1/*` 路由均不开放。文中出现的 `/v1/*` 仅表示服务端调用 NewAPI / Sub2API 时使用的上游协议路径。

本文档是仓库内部开发与验收使用的任务合同，不是第三方接入文档；生产部署不会为未知跨域 Origin 返回 CORS 放行头。

## 认证

所有受保护的内部接口只接受登录接口签发的 HttpOnly Cookie，不接受 `Authorization` 或 `x-api-key` 请求头。正常使用时 Cookie 由同源 Web 应用自动携带；本地调试可先登录并保存 Cookie：

```bash
curl -c ./cloud-cotton.cookies http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<username>","password":"<password>"}'
```

普通用户还需要具备对应内部接口权限；异步创作任务的权限入口是 `GET /api/creation-tasks` 和 `POST /api/creation-tasks`，子路径按同一资源权限生效。

## 模型与链路

图片任务模型主要使用：

| 模型 | 链路 | 说明 |
| --- | --- | --- |
| `auto` | NewAPI 转发 | 默认图片模型选择，具体路由由 NewAPI 配置决定。 |
| `gpt-image-2` | NewAPI 转发 | 转发给当前用户所选 Key 对应的 NewAPI 渠道。 |
| `codex-gpt-image-2` | NewAPI 转发 | 可用于在 NewAPI 中配置独立的 Codex 图片渠道。实际支持取决于渠道。 |
| `gemini-3.1-flash-image` | NewAPI `/v1/chat/completions` | 默认 Google 图片模型；支持参考图，宽高比和分辨率通过 `extra_body.google.image_config` 发送。 |
| `grok-imagine-image` | NewAPI `/v1/images/generations` | 默认 Grok 文生图模型；最新 NewAPI 已内置。 |
| `grok-imagine-image-quality` | NewAPI `/v1/images/generations` | xAI 官方质量模型；NewAPI 当前内置其 `grok-imagine-image-pro` 别名，使用规范名称前需要配置模型映射。 |
| `grok-imagine-image-2.0` | NewAPI `/v1/images/generations` | xAI 官方新模型；当前 NewAPI 使用前需要配置自定义模型映射。 |

云棉从当前登录用户可用的 NewAPI Key 名称中读取选择，并按该名称精确取得密钥。请求随后发送到 `API_BASE_URL`；模型对应的账号、额度和最终上游协议由 NewAPI 决定。内部 `GET /api/profile/upstream-models` 会读取上游模型目录，但图片生成/图片编辑任务只应使用 NewAPI 图片渠道实际支持的模型。

默认模型列表为 `gpt-image-2`、`gemini-3.1-flash-image` 和 `grok-imagine-image`。Google 链路只识别官方当前模型 ID：`gemini-3.1-flash-lite-image`、`gemini-3.1-flash-image`、`gemini-3-pro-image`、`gemini-2.5-flash-image`，不再把旧 Nano Banana 别名当作正式 ID。图片生成可用模型通过 `IMAGE_MODELS` 或设置页统一配置，供创作台、无限画布和工作流内部任务共用；模型必须已在 NewAPI / Sub2API 中存在可用渠道。

图片创作台的行为以参考项目 `web/src/services/api/image.ts` 和 `web/src/app/(user)/image/page.tsx` 为合同来源，不再由本项目自行根据厂商名称隐藏工作台参数。不同上游的差异只在请求适配层处理：

| 分支 | 上游请求 | 参考项目合同 |
| --- | --- | --- |
| Images | `/v1/images/generations` 或 multipart `/v1/images/edits` | 发送当前提示词、当前参考图、尺寸、质量、流式、`partial_images` 和 Base64 选项。 |
| Responses | `/v1/responses` | 使用 `image_generation` tool；参考图放入本次 `input`，不附加创作台历史对话。 |
| Chat | `/v1/chat/completions` | 使用当前提示词和当前参考图构造单条 user message，并请求图片模态。 |
| Gemini | 经 NewAPI 转为 Google 图片配置 | 强制使用 Images 分支；`low/medium/high` 分别映射 `1K/2K/4K`，`auto` 只从精确 2K/4K 预设识别档位；模型名包含 `2.5` 时省略 `image_size`。 |
| Grok2API | 生成用 JSON `/v1/images/generations`；编辑用 JSON `/v1/images/edits` | `size` 转为 `aspect_ratio`；`low` 转 `1k`，`medium/high` 转 `2k`；编辑图片为 `images: [{"url":"data:..."}]`；保留 `stream`、`partial_images` 和 `response_format=b64_json`。 |
| 智谱 | `/v1/images/generations` | 只支持文生图；GLM/CogView 质量按参考项目转换，不发送流式和输出格式选项。 |
| Agnes/KIE/APIMart | 各自适配器 | 字段名、尺寸、数量和参考素材按参考项目对应适配器转换。 |

图片工作台的总生成数量为 `1-10`。每张输出创建一个独立的 `count=1` 异步任务，单张失败不会抹掉同批次中已经成功的结果；无限画布和工作流的底层设置组件可按各自场景使用参考项目的 `1-15` 服务层边界。

## 通用参数

| 字段 | 类型 | 默认值 | 适用接口 | 说明 |
| --- | --- | --- | --- | --- |
| `prompt` | string | 无 | 全部 | 生图或编辑提示词。生成接口必填；编辑接口也建议必填。 |
| `model` | string | `auto` | 全部 | 图片任务模型；默认提供 GPT 图片、Gemini 和 Grok，实际可用性取决于 NewAPI 渠道。 |
| `n` | number | `1` | 全部 | 单个内部任务的输出数量，服务层合同为整数 `1-15`。图片工作台不会批量发送该值，而是把界面选择的 `1-10` 张拆成多个 `n=1` 任务。 |
| `size` | string | 空 | 全部 | 支持 `auto`、比例值、档位和显式尺寸。详见“尺寸”。 |
| `quality` | string | `auto` | 全部 | 工作台始终提供 `auto`、`high`、`medium`、`low`，不按模型隐藏；适配层按上表转换或删除不适用字段。 |
| `response_format` | string | `url` | 内部任务结果格式 | 开启参考项目的 Base64 选项时发送 `b64_json`；Images 和 Grok2API 分支保留该字段，最终结果仍会进入统一任务存储。 |
| `output_format` | string | 空（不指定） | 全部 | 输出保存格式。支持 `png`、`jpeg`、`webp`，`jpg` 会归一化为 `jpeg`，非法值归一化为 `png`。省略时不会自行向上游补 `png`，保存后按图片实际内容记录格式。 |
| `output_compression` | number | 空 | 全部 | 仅 `output_format=jpeg` 或 `webp` 时生效，必须是 `0-100` 的整数；非法值返回 `400`。 |
| `moderation` | string | 空 | 全部 | 透传给图片工具的审核参数。实际支持取决于上游链路。 |
| `partial_images` | number | 空 | 全部 | 仅 `stream=true` 时生效，必须是 `0-3` 的整数；非法值返回 `400`。`0` 不返回中间图，大于 `0` 表示最多返回对应数量。 |
| `mask` | PNG 文件 | 空 | multipart 编辑接口 | GPT 图片局部编辑遮罩，按官方字段上传。必须与首张输入图尺寸一致，首张输入图也必须为 PNG，遮罩必须带 alpha 通道。Gemini/Grok 和文生图接口传入遮罩会返回 `400`。 |
| `input_image_mask` | string | 空 | multipart 编辑接口 | 旧客户端兼容字段，可传 PNG data URL 或纯 base64；服务校验后会转换为上游 multipart `mask` 文件，不会把原始 base64 写入任务或图片元数据。新调用应使用 `mask`。 |
| `input_fidelity` | string | 空 | 编辑接口 | 官方编辑接口用于控制输入图保真度；当前 `gpt-image-2` 链路不下发该参数。 |
| `visibility` | string | `private` | 全部 | 生成图片入库可见性。支持 `private`、`public`。影响图库展示，不影响上游生成语义。 |
| `messages` | array | 空 | 低层内部字段 | 图片工作台不提交历史 messages；每次请求只包含当前提示词和当前参考图。 |
| `stream` | boolean | `false` | 上游执行参数 | Images、Responses 和 Grok2API 分支按参考项目保留流式选项；Gemini、智谱及不支持该字段的专用适配器在适配层删除。内部任务接口通过轮询返回状态，不向浏览器开放第三方 SSE 路由。 |

## 上游流式图片生成

服务端调用 NewAPI 的 Images 或 Grok2API 图片链路时可以使用 `/v1/images/generations` 或 `/v1/images/edits` 流式响应；Responses 分支也可请求流式事件。内部任务参数中设置：

```json
{
  "stream": true,
  "partial_images": 2
}
```

这是服务端与上游之间的 SSE 协议，不是本项目公开路由。内部任务会把已完成结果和可用进度归一化到任务对象。上游 SSE 数据帧通常包含以下事件类型：

| `type` | 说明 |
| --- | --- |
| `image_generation.partial_image` | 渐进预览图；仅请求了 `partial_images=1-3` 且上游渠道支持时可能返回。 |
| `image_generation.completed` | 正式完成图片。最终结果以此事件为准，渐进预览不会覆盖已完成图片。 |
| `[DONE]` | SSE 响应结束标记。 |

典型响应：

```text
: stream-open

data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"<base64-preview>"}

data: {"type":"image_generation.completed","b64_json":"<base64-image>"}

data: [DONE]
```

注意：

- `partial_images` 表示最多返回多少张渐进预览，不保证返回满。部分 NewAPI 渠道只返回 `image_generation.completed` 和 `[DONE]`，仍属于正常的流式完成。
- 如果请求了流式响应，但 NewAPI 或上游返回的是完整 `application/json` 图片结果，服务会把该响应转换为完成事件，不会为了转换格式再次请求上游生成。
- NewAPI 的心跳帧可能表现为 `: PING`、`data: : PING`，某些代理还会产生重复的 `data: data: {...}` 前缀；服务端会兼容这些格式。
- 上游错误不会触发改变请求语义的自动重试，也不会被替换为泛化提示；服务会保留 NewAPI 返回的可用错误详情，便于用户和管理员排查。不支持流式图片的渠道应在界面中关闭流式返回。

## 尺寸

`size` 支持以下写法：

| 写法 | 说明 |
| --- | --- |
| `auto` | 不强制尺寸，由上游决定。 |
| `1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`21:9` | 参考工作台的八个基础比例。只选择比例时，按参考项目的质量基准换算成像素尺寸。 |
| `2048x2048`、`2048x1152`、`1152x2048`、`3136x1344` | 参考工作台的 2K 预设。 |
| `3840x2160`、`2160x3840`、`6272x2688` | 参考工作台的 4K 预设。 |
| `1024x1024`、`1536x2048` 等 | 自定义宽高；默认在输入完成后向上补齐为 16 的倍数，也可关闭补齐。 |

只选择比例时，参考项目使用以下质量基准计算目标尺寸：`low=1024`、`medium=2048`、`high=2880`，`auto` 按 `low` 计算。显式像素预设保持原值，不再次换算。

模型特例：

- Gemini 把工作台尺寸转换为参考项目的八种比例之一；质量优先决定 `image_size`，`auto` 只识别上述精确 2K/4K 预设，模型名包含 `2.5` 时不发送 `image_size`。
- Grok2API 把像素尺寸约分为 `aspect_ratio`；质量映射为 `resolution` 后删除 `quality`，不再同时发送两套互相冲突的字段。

## 异步文生图任务

### `POST /api/creation-tasks/image-generations`

请求体格式：`application/json`

必填字段：

- `client_task_id`：客户端生成的任务 ID。同一用户重复提交同一个 ID 会返回已有任务，用于幂等。
- `prompt`

示例：

```bash
curl http://localhost:8000/api/creation-tasks/image-generations \
  -b ./cloud-cotton.cookies \
  -H "Content-Type: application/json" \
  -d '{
    "client_task_id": "img-task-20260511-001",
    "model": "gpt-image-2",
    "prompt": "一张用于产品发布会的未来城市主视觉",
    "n": 2,
    "size": "21:9",
    "image_resolution": "2k",
    "output_format": "webp",
    "visibility": "private"
  }'
```

提交成功响应示例：

```json
{
  "id": "img-task-20260511-001",
  "status": "queued",
  "mode": "generate",
  "model": "gpt-image-2",
  "size": "21:9",
  "count": 2,
  "created_at": "2026-05-11 13:44:41",
  "updated_at": "2026-05-11 13:44:41",
  "output_format": "webp",
  "output_statuses": ["queued", "queued"],
  "visibility": "private"
}
```

任务提交后后台异步执行。调用方需要使用查询接口轮询任务状态。

## 异步图生图任务

### `POST /api/creation-tasks/image-edits`

请求体格式：`multipart/form-data`

必填字段：

- `client_task_id`
- `prompt`
- `image` 或 `image[]`

示例：

```bash
curl http://localhost:8000/api/creation-tasks/image-edits \
  -b ./cloud-cotton.cookies \
  -F "client_task_id=edit-task-20260511-001" \
  -F "model=auto" \
  -F "prompt=保留人物姿态，改成电影海报质感" \
  -F "n=1" \
  -F "size=3:4" \
  -F "image_resolution=1080p" \
  -F "output_format=png" \
  -F "visibility=public" \
  -F "image=@./portrait.png"
```

带遮罩示例：

```bash
curl http://localhost:8000/api/creation-tasks/image-edits \
  -b ./cloud-cotton.cookies \
  -F "client_task_id=edit-task-mask-001" \
  -F "model=gpt-image-2" \
  -F "prompt=只替换背景为雪山，主体不变" \
  -F "image=@./input.png" \
  -F "mask=@./mask.png"
```

## 查询任务

### `GET /api/creation-tasks`

查询当前用户的任务列表：

```bash
curl "http://localhost:8000/api/creation-tasks" \
  -b ./cloud-cotton.cookies
```

按任务 ID 查询：

```bash
curl "http://localhost:8000/api/creation-tasks?ids=img-task-20260511-001,edit-task-20260511-001" \
  -b ./cloud-cotton.cookies
```

响应示例：

```json
{
  "items": [
    {
      "id": "img-task-20260511-001",
      "status": "success",
      "mode": "generate",
      "model": "gpt-image-2",
      "size": "21:9",
      "created_at": "2026-05-11 13:44:41",
      "updated_at": "2026-05-11 13:45:12",
      "output_format": "webp",
      "output_statuses": ["success", "success"],
      "visibility": "private",
      "data": [
        {
          "url": "http://localhost:8000/images/2026/05/11/example-1.webp",
          "revised_prompt": "一张用于产品发布会的未来城市主视觉",
          "output_format": "webp"
        },
        {
          "url": "http://localhost:8000/images/2026/05/11/example-2.webp",
          "revised_prompt": "一张用于产品发布会的未来城市主视觉",
          "output_format": "webp"
        }
      ]
    }
  ],
  "missing_ids": []
}
```

## 取消任务

### `POST /api/creation-tasks/{id}/cancel`

示例：

```bash
curl http://localhost:8000/api/creation-tasks/img-task-20260511-001/cancel \
  -b ./cloud-cotton.cookies \
  -H "Content-Type: application/json" \
  -d '{}'
```

如果任务仍处于 `queued` 或 `running`，服务会标记为 `cancelled` 并尝试取消后台执行。已完成任务重复取消会返回当前任务状态。

## 任务状态

任务级 `status`：

| 状态 | 含义 |
| --- | --- |
| `queued` | 已入队，等待执行。 |
| `running` | 正在执行。 |
| `success` | 已成功完成。 |
| `error` | 执行失败。错误文本在 `error` 字段。 |
| `cancelled` | 已取消。 |

图片输出级 `output_statuses`：

| 状态 | 含义 |
| --- | --- |
| `queued` | 单张输出等待开始。 |
| `running` | 单张输出正在生成。 |
| `success` | 单张输出已产出图片或文本结果。 |
| `error` | 单张输出失败，或生成成功但本地余额/配额扣减失败因此未交付。 |
| `cancelled` | 单张输出随任务终止。 |

`output_statuses` 的长度通常与 `n` 一致，适合 Web 端逐张展示占位和进度。

## 响应字段

任务对象常见字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 客户端提交的 `client_task_id`。 |
| `status` | string | 任务状态。 |
| `mode` | string | `generate`、`edit` 或 `chat`。本文档关注 `generate` 和 `edit`。 |
| `model` | string | 实际记录的模型。 |
| `size` | string | 请求尺寸或比例。 |
| `count` | number | 任务占用的输出单位；图片为请求数量，视频、音频和文本固定为 1。 |
| `quality` | string | 请求质量，未传时可能省略。 |
| `output_format` | string | 请求明确指定时为归一化后的格式；未指定时任务级字段可能省略。 |
| `output_compression` | number | JPEG/WebP 压缩率，仅 JPEG/WebP 时可能出现。 |
| `moderation` | string | 审核参数，传入时可能出现。 |
| `partial_images` | number | 流式中间图参数，`stream=true` 时保留 `0-3`；显式 `0` 不会被当成缺省值。 |
| `output_statuses` | string[] | 单张输出状态。 |
| `data` | array | 输出结果数组。成功后出现。 |
| `error` | string | 失败原因。失败或取消时可能出现。 |
| `output_type` | string | 文本型结果时为 `text`。 |
| `visibility` | string | `private` 或 `public`。 |
| `created_at` | string | 本地时间字符串。 |
| `updated_at` | string | 本地时间字符串。 |

图片结果项常见字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 服务保存后的图片 URL。 |
| `b64_json` | string | 上游返回并被任务保留的 base64 图片；内部 Web 工作流通常使用保存后的 `url`。 |
| `revised_prompt` | string | 上游或服务记录的最终提示词。 |
| `output_format` | string | 根据保存图片实际内容识别的输出格式。 |

图片可见性和 JPEG/WebP 压缩率当前主要在任务级字段返回。调用方展示图库状态时优先读取任务级 `visibility`；保存后的图片元数据由服务端图库模块维护。

文本结果项：

```json
{
  "output_type": "text",
  "data": [
    {
      "text_response": "你好！我是 ChatGPT。"
    }
  ]
}
```

## 文本型结果说明

图片接口调用上游后，可能得到文本回复而不是图片。例如用户输入“你好，你是什么模型？”时，上游可能按聊天问题回答而不是调用图片工具。

内部 `/api/creation-tasks/image-generations` 和 `/api/creation-tasks/image-edits` 任务会被标记为 `success`，同时返回 `output_type=text` 和 `data[].text_response`，避免 Web 端只显示泛化的失败提示。

调用方如果只接受图片，需要在任务成功后检查：

- `task.output_type !== "text"`
- `task.data[]` 中存在 `url` 或 `b64_json`

## 错误格式

认证失败：

```json
{
  "detail": {
    "error": "authorization is invalid"
  }
}
```

普通参数错误：

```json
{
  "detail": {
    "error": "prompt is required"
  }
}
```

图片额度不足：

```json
{
  "error": {
    "message": "no available image quota",
    "type": "insufficient_quota",
    "param": null,
    "code": "insufficient_quota"
  }
}
```

常见错误：

| HTTP 状态 | 场景 | 错误文本或 code |
| --- | --- | --- |
| `400` | JSON 解析失败 | `invalid json body` |
| `400` | 缺少提示词 | `prompt is required` |
| `400` | 异步任务缺少 ID | `client_task_id is required` |
| `400` | `n` 不是整数或超出服务层范围 | `n must be between 1 and 15` |
| `400` | `partial_images` 或 `output_compression` 不是整数或越界 | `partial_images must be an integer between 0 and 3` 或 `output_compression must be an integer between 0 and 100` |
| `400` | 图生图缺少图片 | `image file is required` 或 `image is required` |
| `400` | 遮罩接口、模型、格式、alpha 或尺寸不合法 | `mask is only supported by the image edits endpoint`、`does not support mask editing through NewAPI` 或具体 PNG 校验错误 |
| `400` | `messages` 表单字段不是 JSON | `invalid messages` |
| `400` | 非法可见性 | `visibility must be private or public` |
| `400` | 上游返回文本而非图片 | `image_generation_text_response` |
| `401` | 未认证或 token 无效 | `authorization is invalid` |
| `403` | 权限不足 | `permission denied` |
| `429` | 图片额度或任务并发限制 | `insufficient_quota` 或任务限制错误文本 |
| `502` | 上游或协议失败 | `upstream_error`、上游返回的错误详情，或无图片输出时的诊断消息 |

## 上下文边界

内部图片任务默认是无状态的：

- 每个 `/api/creation-tasks/image-generations` 任务只应依赖本次任务 payload。
- 低层任务仍能承载某些模式需要的结构化输入，但图片工作台不会把历史对话作为 `messages` 附加到新任务。
- `visibility`、任务历史、图库记录只用于本地管理，不会自动变成下一次官方图片链路的上下文。

云棉 Web 创作台使用独立的服务端会话历史：同一用户可以跨设备读取对话，并由前端按当前轮次显式提交提示词和参考图。无限画布项目也保存在服务端。两者都不会让新的内部任务自动继承上一次请求的上下文。

## 图片保存与清理

- 内部任务的正式生成结果都会保存到服务端图片库；`visibility` 决定图片是 `private` 还是 `public`。
- 服务端图片库只使用本地存储，图片通过 `/images/...` 登录态鉴权接口访问。
- Web 创作台、无限画布和工作流会把最终图片通过统一 `/api/files` 合同写入管理员或用户配置的 S3/R2、WebDAV Provider；未配置 Provider 时回退浏览器 IndexedDB。
- `partial_images` 渐进预览只用于当前响应；只有最终完成的图片会进入图库和统一结果存储。
- 生成结果关联的缩略图、元数据和参考图会随原图作为一组治理。
- Web 创作台上传的图生图参考图保存到 `/app/data/image_conversation_assets/`，访问时校验所属用户。
- `IMAGE_RETENTION_DAYS` 同时作用于生成结果和创作台会话参考图。参考图文件过期后，历史对话文字、参数和任务元数据仍会保留，但图片将不可访问。
- `IMAGE_STORAGE_LIMIT_MB` 按治理页口径统计生成原图、缩略图、元数据和会话参考图；清理原图时会同步删除其关联参考图。`0` 表示不按容量自动清理。
- 公开图片默认不参与普通自动清理；管理员执行存储清理时可以明确选择包含公开图片。
- 管理员在设置页维护统一 S3/R2、WebDAV Provider、容量上限和统计 Cron；普通用户可以在个人资料页维护个人 Provider，敏感凭据不会由设置接口返回明文。
- 登录后会自动迁移浏览器 IndexedDB 中尚未进入 Provider 的图片、视频和音频；容量统计可由管理员手动执行，也可按 Cron 自动执行。

## 推荐调用流程

Web 端推荐使用异步任务接口：

1. 前端生成唯一 `client_task_id`。
2. 调用 `/api/creation-tasks/image-generations` 或 `/api/creation-tasks/image-edits` 提交任务。
3. 使用 `GET /api/creation-tasks?ids=<client_task_id>` 轮询。
4. 当 `status=success` 且 `output_type` 不是 `text` 时展示 `data[].url`。
5. 当 `status=success` 且 `output_type=text` 时展示 `data[].text_response` 或提示用户改用明确的绘图提示词。
6. 当 `status=error` 或 `cancelled` 时展示 `error`。

这些接口仅供本项目登录后的 Web 前端使用，不承诺第三方 SDK 兼容性或长期公共协议稳定性。
