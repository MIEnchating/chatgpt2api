# Grok 与 Gemini 生图接口及参数

核对日期：2026-09-20。官方接口部分依据当日公开文档；项目部分依据当前仓库实现。示例用于说明请求格式，未调用收费生图接口验证。模型可用性、额度和限流以账号及实际渠道为准。

## 1. 接口速查

| 调用目标 | 文生图 | 参考图编辑 | 认证 |
| --- | --- | --- | --- |
| xAI 官方 | `POST https://api.x.ai/v1/images/generations` | `POST https://api.x.ai/v1/images/edits`，JSON | `Authorization: Bearer <XAI_API_KEY>` |
| Google 官方 Interactions | `POST https://generativelanguage.googleapis.com/v1beta/interactions` | 同一接口，在 `input` 中加入图片 | `x-goog-api-key: <GEMINI_API_KEY>` |
| Google 官方 generateContent | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | 同一接口，在 `contents[].parts` 中加入图片 | `x-goog-api-key: <GEMINI_API_KEY>` |
| 本项目 → NewAPI：Grok | `POST {NEWAPI_BASE_URL}/v1/images/generations` | `POST {NEWAPI_BASE_URL}/v1/images/edits`，JSON | 上游 Key 的 Bearer 认证 |
| 本项目 → NewAPI：Gemini | `POST {NEWAPI_BASE_URL}/v1/chat/completions` | 同一接口，在 `messages` 中加入图片 | 上游 Key 的 Bearer 认证 |
| 浏览器 → 本项目 | `POST /api/creation-tasks/image-generations`，JSON | `POST /api/creation-tasks/image-edits`，multipart | 登录态 Cookie |

Google 当前生图指南使用 Interactions；迁移指南明确说明 generateContent 仍受支持，新开发推荐 Interactions。二者请求体不可混用。本项目尚未直接调用 Interactions，而是交给 NewAPI 的 Gemini 图片适配处理。

**本项目不开放 `/v1/*` 公共接口。** 表中的 NewAPI 地址是上游地址，不能替换为本项目的 `http://127.0.0.1:8090`。以下 `NEWAPI_BASE_URL` 表示不含末尾 `/v1` 的服务地址。

## 2. Grok：xAI 官方接口

### 2.1 模型

当前官方生图、编辑指南以 `grok-imagine-image-2.0` 为示例。项目默认模型仍为 `grok-imagine-image`，也识别 `grok-imagine-image-quality`、`grok-imagine-image-pro` 等名称；“项目识别模型名”不代表上游渠道已经提供该模型。

接入 2.0 前应确认 NewAPI 渠道支持该 ID，必要时在渠道配置模型映射。本项目保留所选模型名，不会自动改成其他型号。

### 2.2 文生图参数

接口：`POST /v1/images/generations`，请求类型：`application/json`。

| 参数 | 类型 | 必填 / 默认 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 必填 | 示例使用 `grok-imagine-image-2.0`。 |
| `prompt` | string | 必填 | 画面、主体、风格、文字、构图等描述。 |
| `n` | integer | 默认 `1` | 官方文生图指南范围为 `1–10`。 |
| `aspect_ratio` | string | 默认 `auto` | 输出画幅，见下方枚举。 |
| `resolution` | string | 默认 `1k` | `1k`、`2k`，小写。 |
| `quality` | string | 默认 `auto` | **仅 2.0 支持**：`low`、`medium`、`auto`；没有 `high`。当前 `auto` 在生成时选 `low`、编辑时选 `medium`，按实际质量计费。 |
| `response_format` | string | 默认 `url` | `url` 返回临时图片地址；`b64_json` 返回 Base64 图片。与文件编码格式不是同一个参数。 |

官方当前列出的画幅：

```text
auto, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3,
2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20, 21:9, 5:2
```

`resolution` 与 `quality` 是两个独立参数；不要用 OpenAI Images 的 `size=1024x1024` 代替官方画幅及分辨率字段。项目对 `stream`、`partial_images` 的透传用于支持这些字段的渠道，不应据此推断 xAI 官方生图接口支持同样的流式合同。

```bash
curl https://api.x.ai/v1/images/generations \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "grok-imagine-image-2.0",
    "prompt": "一只橘猫坐在窗边，暖色日光，写实摄影",
    "n": 1,
    "aspect_ratio": "16:9",
    "resolution": "2k",
    "quality": "medium",
    "response_format": "b64_json"
  }'
```

### 2.3 参考图编辑

接口：`POST /v1/images/edits`，请求类型仍为 **`application/json`，不是 multipart**。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `model`、`prompt` | string | 必填；提示词描述要修改及保留的内容。 |
| `image` | object | 单图入口，示例结构为 `{"type":"image_url","url":"..."}`。 |
| `images` | object[] | 多图入口，与单图入口择一使用；官方当前多图指南上限为 **5 张**。 |
| `image.url` / `images[].url` | string | 可公开访问的图片 URL，或 `data:image/png;base64,...` 等 data URI。 |
| `aspect_ratio` | string | 不指定时，多图编辑默认跟随首张输入图；可显式覆盖。 |
| `quality` | string | 2.0 的 `low`、`medium`、`auto`；默认自动策略见上表。 |
| `response_format` | string | `url` 或 `b64_json`。 |

官方也支持 Files API 的 `file_id` 输入；本项目当前编辑适配使用 data URI，不暴露该文件引用合同。

以下示例先将本地图片编码为 JSON；需安装 `jq`，`reference.png` 为调用者自己的文件：

```bash
base64 -w 0 ./reference.png | jq -Rs '{
  model: "grok-imagine-image-2.0",
  prompt: "保留主体，将背景换成雪山，写实摄影",
  image: {type: "image_url", url: ("data:image/png;base64," + .)},
  aspect_ratio: "16:9",
  response_format: "b64_json"
}' > /tmp/grok-image-edit.json

curl https://api.x.ai/v1/images/edits \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/grok-image-edit.json
```

多图编辑将 `image` 换成 `images` 数组，按提示词所指的顺序排列各张参考图。

### 2.4 返回结果

核心图片结果位于 `data[]`：读取 `data[].url` 或 `data[].b64_json`。URL 是临时地址，应及时下载；Base64 数据须解码后再保存。实际文件扩展名应按返回图片内容判断。

下面是字段示意，`<BASE64_IMAGE_DATA>` 为占位符：

```json
{
  "data": [
    {"b64_json": "<BASE64_IMAGE_DATA>"}
  ]
}
```

## 3. Gemini：Google 官方接口

### 3.1 模型与图片能力

| 模型 ID | 定位 | 分辨率能力 | 参考图说明 |
| --- | --- | --- | --- |
| `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite，速度优先 | 仅 `1K` | Gemini 3 系列总量上限 14；官方说明此型号未针对多参考图及多轮连续编辑优化。 |
| `gemini-3.1-flash-image` | Nano Banana 2，通用生图 | 512px、`1K`、`2K`、`4K` | 最多 14；指南给出的保真能力包括最多 10 个物体、4 个角色。 |
| `gemini-3-pro-image` | Nano Banana Pro，复杂视觉任务 | `1K`、`2K`、`4K` | 最多 14；物体、角色、风格参考的保真能力不同，不能视为任意 14 张都具有同等效果。 |
| `gemini-2.5-flash-image` | Nano Banana | 默认图片尺寸 | 官方建议输入不超过 3 张以获得较好效果；项目前端也按 3 张限制。 |

项目另外识别 `gemini-3.1-flash-image-preview`，但本次官方指南使用正式 ID。使用 preview 名称时须由渠道提供支持，本项目不会自动替换名称。

标准画幅：

```text
1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
```

`gemini-3.1-flash-image` 另支持 `1:4`、`4:1`、`1:8`、`8:1`。默认画幅通常匹配输入图，没有输入图时为 `1:1`。分辨率是档位，实际像素尺寸随画幅变化，不代表固定宽高。Gemini 生成图片含 SynthID 水印。

### 3.2 Interactions 请求参数

接口：`POST https://generativelanguage.googleapis.com/v1beta/interactions`。

| 参数 | 类型 | 必填 / 说明 |
| --- | --- | --- |
| `model` | string | 必填，选择图片生成模型。 |
| `input` | string / array | 必填。纯文本可以直接使用字符串；编辑时使用文本、图片内容块数组。 |
| `input[].type` | string | 本文使用 `text`、`image`。 |
| `input[].text` | string | `type=text` 时的提示词。 |
| `input[].mime_type` | string | `type=image` 时的真实图片 MIME，例如 `image/png`。 |
| `input[].data` | string | 参考图的纯 Base64，**不带 data URI 前缀**。 |
| `response_format` | object / array | 指定输出类型；仅图片用对象，同时返回文本与图片用数组。 |
| `response_format.type` | string | 生图设置 `image`；文本块设置 `text`。 |
| `response_format.aspect_ratio` | string | 对图片输出设置上述画幅。 |
| `response_format.image_size` | string | 图片分辨率；本文已核对示例使用 `1K`、`2K`、`4K`，`K` 必须大写。仅向支持该档位的模型发送。 |
| `response_format.mime_type` | string | 可指定输出图片 MIME，官方示例为 `image/jpeg`。 |
| `previous_interaction_id` | string | 多轮编辑时引用上一轮 interaction；本项目内部图片任务不会自动传递该字段。 |

512px 是 3.1 Flash Image 的能力；官方本次页面对该档位同时使用 512px / 0.5K 表述，本文未核实 Interactions 对应的准确枚举，示例不使用该值。不要将项目中的 `image_resolution=512` 直接视为 Interactions 的参数值。

Gemini 没有与 Grok `quality=low/medium` 对等的生图质量字段；也不要直接复制 Grok 的 `n` 或 `response_format="b64_json"`。提示词要求的输出张数不保证被严格满足，固定数量应由调用方编排多次请求。

### 3.3 Interactions 文生图与编辑示例

文生图：

```bash
curl https://generativelanguage.googleapis.com/v1beta/interactions \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-3.1-flash-image",
    "input": "设计一张春季咖啡新品海报，中文标题为春日拿铁，清新自然",
    "response_format": {
      "type": "image",
      "aspect_ratio": "3:4",
      "image_size": "2K"
    }
  }'
```

编辑请求体示意，将 `<BASE64_IMAGE_DATA>` 替换为真实图片编码后发送到同一地址：

```json
{
  "model": "gemini-3.1-flash-image",
  "input": [
    {"type": "text", "text": "保留产品外观，将背景改成浅绿色植物场景"},
    {"type": "image", "mime_type": "image/png", "data": "<BASE64_IMAGE_DATA>"}
  ],
  "response_format": {
    "type": "image",
    "aspect_ratio": "3:4",
    "image_size": "2K"
  }
}
```

返回值按 `steps[]` 解析：筛选 `type=model_output` 的步骤，再读取 `content[]` 中 `type=image` 的内容块，解码其中的 `data`，并按 `mime_type` 保存。文本内容块读取 `text`。不要把 `thought` 中的中间图片当作最终结果。SDK 的 `output_image` 便捷属性只返回最后一个图片块，不能用于收集所有图片。

### 3.4 generateContent 字段对照

对于直接使用 generateContent 的渠道，生图请求格式如下；它与上面的 Interactions 是不同合同：

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "画一只在花园里晒太阳的橘猫"}]}],
    "generationConfig": {
      "responseModalities": ["TEXT", "IMAGE"],
      "imageConfig": {"aspectRatio": "1:1", "imageSize": "2K"}
    }
  }'
```

| 用途 | generateContent REST 字段 |
| --- | --- |
| 提示词 | `contents[].parts[].text` |
| 内联参考图 | `contents[].parts[].inlineData.mimeType` 和 `inlineData.data`，后者为纯 Base64 |
| 输出模态 | `generationConfig.responseModalities`，例如 `["TEXT","IMAGE"]` |
| 画幅 / 分辨率 | `generationConfig.imageConfig.aspectRatio` / `imageSize` |
| 输出图片 | 遍历 `candidates[].content.parts[]` 中的 `inlineData`，读取 `mimeType` 和 `data` |

不要将 Python SDK 的 snake_case 字段直接当成这里的 REST camelCase 字段。模型名放在 URL 中；2.5 Flash Image 不应照抄 3.x 的 `imageSize` 设置。

## 4. 本项目实际发送给 NewAPI 的请求

### 4.1 Gemini Chat Completions

文生图、图生图都发送至 `POST /v1/chat/completions`。以下是项目专用 Gemini 适配器的 HTTP JSON 结构：

```json
{
  "model": "gemini-3.1-flash-image",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "保留产品外观，将背景改成浅绿色植物场景"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,<BASE64_IMAGE_DATA>"}}
      ]
    }
  ],
  "extra_body": {
    "google": {
      "image_config": {"aspect_ratio": "3:4", "image_size": "2K"}
    }
  }
}
```

无参考图时，`messages[0].content` 可直接为提示词字符串。这里的 `extra_body` 是实际 HTTP JSON 字段；部分 SDK 的同名调用参数会展开字段，使用 SDK 时必须核对最终发出的 JSON。

当前适配器仅构造 `model`、`messages` 和可选的 `extra_body.google.image_config`，不应把其他渠道的顶层 `image_config` 或 `modalities` 当作本项目此分支的必填参数。

项目将 `n` 拆成多次上游聊天请求，最多收集所需数量，不将它作为 Gemini 原生生图张数参数。返回支持内嵌 Base64 图片和 `message.content` 中的 Markdown 图片链接；普通文本链接不当作图片。远程结果会下载、校验并保存。

### 4.2 Grok Images

生成请求使用第 2 节的 Images 路径；编辑请求把本地上传图转换为：

```json
{
  "model": "grok-imagine-image",
  "prompt": "保留主体，将背景换成雪山",
  "images": [{"url": "data:image/png;base64,<BASE64_IMAGE_DATA>"}],
  "n": 1,
  "aspect_ratio": "16:9",
  "resolution": "2k",
  "response_format": "b64_json"
}
```

实际发送至 NewAPI 的 `/v1/images/edits`，不是向 xAI 上传 multipart。渠道须接受项目使用的 `images[].url` 结构。

### 4.3 项目参数映射及边界

| 项目参数 / 能力 | Gemini | Grok |
| --- | --- | --- |
| `size` | 内置适配根据比例或像素尺寸选择最接近的支持画幅，写入 `aspect_ratio`。 | 转换为支持的 `aspect_ratio`，不发送原始 `size`。 |
| 默认内置适配的 `quality` | 当前主执行链在构造 Gemini 请求前删除该字段，不能依赖它控制分辨率；2.5 模型省略 `image_size`。 | `low` 映射 `1k`，`medium/high` 映射 `2k`，随后删除 `quality`。**这不会设置 Grok 2.0 官方质量档位。** |
| 配置模型定义后的 `image_resolution` | 直接写入 `image_config.image_size`，转换为大写。 | 直接写入 `resolution`，转换为小写。 |
| 配置模型定义后的 `quality` | Gemini 协议不提供质量档位。 | 根据配置直接发送 `quality`，不再用它换算分辨率。 |
| `n` | 项目底层接受 `1–15`，通过多次上游请求完成。 | 项目底层接受 `1–15`，但 xAI 官方文生图范围为 `1–10`，需遵守更小的渠道上限。 |
| 参考图 | 内置前端能力：Gemini 3 为 14，2.5 为 3。 | 内置前端能力仍为 4；官方当前多图指南为 5。 |
| 画幅差异 | 标准 10 种；3.1 Flash Image 额外支持 4 种。 | 内置枚举未包含官方新增的 `21:9`、`5:2`；不能假设默认适配会正确透传。 |
| `stream` / `partial_images` | 专用 Gemini 适配不提供图片流式输出。 | 可为支持的渠道保留；内部任务仍通过轮询读取状态。 |
| `mask` | 不支持，提交会报错。 | 不支持，提交会报错。 |

没有自定义定义时，Gemini 的分辨率辅助函数虽然包含 `low/medium/high → 1K/2K/4K` 换算，但主执行链先调用归一化函数删除 `quality`，实际不能保证该换算生效；辅助函数还会从特定尺寸预设识别 2K/4K，却不直接读取 `image_resolution`。因此，不能只填 `quality=medium` 或 `image_resolution=2k` 就认定必然发送 `image_size=2K`。Flash Lite 的官方能力只有 1K，不能因为工作台提供 `high` 就向它要求 4K。

需要精确控制时，在“设置 → 全局模型配置”中为模型配置 `google-gemini-image` 或 `xai-image`，声明渠道实际支持的 `aspect_ratios`、`resolutions`、`quality_values`、`max_reference_images`、`max_output_count` 等。配置后，使用 `quality=auto` 加明确的 `image_resolution` 选择分辨率；Grok 2.0 可另外声明 `quality_values=["low","medium"]` 来保留其原生质量语义。配置不会自动让上游获得这些能力。

Gemini 内联请求在项目中按**序列化后的整个请求体**执行 `20 * 1024 * 1024` 字节限制，超限返回 `413`；Base64 膨胀也计算在内。这是当前项目的实际限制，不应当作所有 Google 接口、Files API 的统一文件上限。

## 5. 调用本项目的异步图片任务

完整任务合同见 [内部生图任务文档](./image-generation-api.md)。接口供本项目登录用户使用，不是第三方公共 API。

### 5.1 参数表

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `client_task_id` | string | 必填，由客户端生成；同一用户重复提交同一 ID 返回已有任务。 |
| `model` | string | 应明确指定已配置且渠道可用的图片模型。 |
| `prompt` | string | 生图或编辑描述。 |
| `n` | integer | 默认 1；建议单任务 1 张，便于分别重试。 |
| `size` | string | 例如 `16:9`、`3:4`；实际处理见映射表。 |
| `quality` | string | 工作台语义为 `auto/low/medium/high`；自定义模型定义启用后按其配置校验。 |
| `image_resolution` | string | 例如 `1k`、`2k`、`4k`；按模型定义和适配规则使用。 |
| `response_format` | string | 上游支持时使用 `url` 或 `b64_json`；最终结果仍进入任务存储。 |
| `relay_token_name` | string | 选择当前用户可用的 NewAPI Key 名称，不是实际密钥。 |
| `visibility` | string | `private` 或 `public`，默认 `private`。 |
| `image` / `image[]` | file | 仅编辑接口，使用 multipart 上传一张或多张参考图。 |

### 5.2 登录、提交和查询

登录并保存 Cookie：

```bash
curl -c ./cloud-cotton.cookies http://127.0.0.1:8090/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<username>","password":"<password>"}'
```

提交 Gemini 文生图任务。示例省略画质，使用渠道默认分辨率，适用于未添加自定义模型定义的默认配置：

```bash
curl http://127.0.0.1:8090/api/creation-tasks/image-generations \
  -b ./cloud-cotton.cookies \
  -H 'Content-Type: application/json' \
  -d '{
    "client_task_id": "gemini-image-example-001",
    "model": "gemini-3.1-flash-image",
    "prompt": "一只在花园里晒太阳的橘猫，写实摄影",
    "n": 1,
    "size": "16:9",
    "visibility": "private"
  }'
```

Grok 文生图使用同一任务接口，将 `model` 改为已配置的 Grok 模型即可。若有多个 Key 可用，可补充 `relay_token_name` 精确选择。

提交 Grok 编辑任务：

```bash
curl http://127.0.0.1:8090/api/creation-tasks/image-edits \
  -b ./cloud-cotton.cookies \
  -F 'client_task_id=grok-edit-example-001' \
  -F 'model=grok-imagine-image' \
  -F 'prompt=保留主体，将背景换成雪山' \
  -F 'n=1' \
  -F 'size=16:9' \
  -F 'visibility=private' \
  -F 'image=@./reference.png'
```

Gemini 编辑使用同一任务接口，更换模型名即可；由后端转换为 Gemini 消息内容。新增任务必须使用新的 `client_task_id`。

提交成功返回任务对象，不代表已经生成成功。轮询查询：

```bash
curl 'http://127.0.0.1:8090/api/creation-tasks?ids=gemini-image-example-001,grok-edit-example-001' \
  -b ./cloud-cotton.cookies
```

读取 `items[]`：`queued` 表示排队，`running` 表示执行中，`success` 表示完成，`error` / `cancelled` 表示失败或取消。成功图片读取 `data[].url`；失败查看 `error`。图片地址仍受本项目访问控制约束。内部接口不接受用 Bearer Key 替代登录 Cookie。

## 6. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 模型不存在 / 不可用 | 本项目模型列表、NewAPI 渠道模型及映射是否一致；preview 名称不能假设与正式名称通用。 |
| Grok `quality=high` 被拒绝 | 官方 2.0 只有 `low/medium/auto`；本项目工作台的 `high` 属于另一层语义。 |
| Grok 编辑返回请求格式错误 | 直连 xAI 或 NewAPI 使用 JSON；调用本项目内部编辑接口才上传 multipart。 |
| Gemini 没有按 2K/4K 输出 | 检查型号能力、参数大小写，以及当前使用的是 Interactions、generateContent、NewAPI 还是本项目任务接口。 |
| Gemini 只返回文字 | 遍历全部输出块，确认使用图片模型、提示词明确要求绘图，并检查响应中的停止原因或阻止信息。 |
| Gemini 返回 `413` | 减少或压缩参考图；按整个 Base64 JSON 请求体计算体积。 |
| 同一请求总返回旧任务 | 更换 `client_task_id`，重复 ID 用于幂等，不会重新生成。 |
| 上游 URL 无法展示或已过期 | 及时下载；在项目任务中优先使用保存后的 `data[].url`。 |

## 7. 核对来源

官方资料（访问日期：2026-09-20）：

- [xAI Image Generation](https://docs.x.ai/developers/model-capabilities/images/generation)：生成路径、张数、画幅、分辨率、质量及返回格式。
- [xAI Image Editing](https://docs.x.ai/developers/model-capabilities/images/editing)：JSON 编辑请求与单图输入。
- [xAI Multi-Image Editing](https://docs.x.ai/developers/model-capabilities/images/multi-image-editing)：5 张参考图及多图输入格式。
- [Google Gemini Image Generation](https://ai.google.dev/gemini-api/docs/image-generation)：当前模型、Interactions 生图示例、分辨率和参考图能力。
- [Google Migrate to Interactions](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)：推荐入口及 generateContent 仍受支持的说明。
- [Google generateContent API Reference](https://ai.google.dev/api/generate-content)：`generationConfig`、`imageConfig` 和 REST 字段定义。

项目实现：

- [内部任务与认证](./image-generation-api.md)
- [上游协议适配与参数转换](../internal/httpapi/relay.go)
- [模型自定义能力与参数校验](../internal/httpapi/image_model_definitions.go)
- [模型路由及 Grok 内置枚举](../internal/util/image_model_capabilities.go)
- [前端模型能力](../web/src/lib/image-model-capabilities.ts)

本次只整理文档，没有调整模型默认值、参数转换或渠道配置。
