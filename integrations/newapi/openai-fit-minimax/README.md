# openai.fit MiniMax 视频插件

`openai-fit-minimax-video-1.0.2.js` 是可直接上传 New API 的独立插件，标识 `openai-fit-minimax`，版本 `1.0.2`。内嵌五份视频契约，不依赖外部 JSON、脚本或在线代码加载，不含 API Key。

## 安装与配置

1. 在 New API 插件管理上传 `.js` 并激活。
2. 创建“任务插件”渠道，绑定 `openai-fit-minimax`，Base URL 填 `https://openai.fit`，不追加 `/v1`；渠道中填写 openai.fit 的 Key。
3. 从下表复制所需的完整模型 ID，保留大小写、空格和连字符；配置分组、令牌权限及售价。
4. 本项目创作台需要使用这些模型时，导入 `contract.json`，将线路指向上述 New API 渠道并使用 New API 令牌。
5. New API 的任务轮询建议设为 15 秒，等待预算至少 3600 秒。契约中的轮询配置不自动修改 New API 宿主设置。

`contract.json` 是“创作台 → 本插件”的请求契约。H3-self 的分辨率、画幅和编号素材转换由本插件完成，不能把该契约直接用于供应商直连，也不能用通用生成器替换此适配插件。无需将契约另外上传到 New API。

## 模型范围

| 完整模型 ID | 秒数 | 清晰度 | 画幅 | 参考图/视频/音频上限 | 供应商计费 |
| --- | --- | --- | --- | --- | --- |
| `minimax H3-self` | 1–15，默认 5 | 480p / 768p | 9:16 / 16:9 | 9/0/0 | 按秒 |
| `minimax H3 768 Spica` | 固定 15 | 768P | 9:16 / 16:9 | 9/0/1；音频须搭配图片 | 按次 |
| `minimax-h3-chovy` | 固定 15 | 480P / 768P / 1088P / 1440P | 9:16 / 16:9 | 9/0/3 | 按次、按清晰度分档 |
| `minimax H3` | 4–15，默认 15 | 480P | 9:16 / 16:9 / 1:1 / 3:4 / 4:3 / 2:3 / 3:2 / 21:9 | 5/0/0 | 按秒 |
| `minimax-H3-super` | 固定 15 | 480P / 768P / 1088P / 1440P | 9:16 / 16:9 | 9/0/0 | 按次、按清晰度分档 |

各模型提供文生视频和参考素材模式；不开放首尾帧和参考视频。供应商建议至少带一张参考图，但没有将图片定义为所有模型的必填项。未公布独立合计限制时，合计上限取各素材类型上限之和；这不代表所有组合均已实测。

H3-self 客户端默认选择 `768p`、`9:16`；Spica 客户端默认选择 `9:16`。这些是本契约的客户端选择，不声称供应商声明了相同的服务端默认值。其余默认值来自实时模型说明。未公布的提示词长度、素材大小、组合限制不作猜测。

插件按计费方式报告用量：H3-self 和 H3 使用 `seconds`、`resolution`，Spica、Chovy、H3-super 使用 `count: 1`、`resolution`。插件不内置供应商价格或售价。H3-self 的用量清晰度使用客户端的 `480p` / `768p`；按次模型应在 New API 配置按条价格，并按需要区分清晰度，不能误用秒数乘价。

## 请求与转换

客户端向 New API 提交：

```json
{
  "model": "minimax H3-self",
  "prompt": "参考图中的人物缓慢向前走",
  "seconds": 5,
  "ratio": "16:9",
  "resolution": "768p",
  "image_urls": ["https://media.example.com/person.jpg"]
}
```

本插件向供应商发送：

```json
{
  "model": "minimax H3-self",
  "prompt": "参考图中的人物缓慢向前走",
  "seconds": 5,
  "resolution": "768p横",
  "ref_image_0": "https://media.example.com/person.jpg"
}
```

- H3-self 按 `resolution` 与 `ratio` 组合生成上游的 `480p竖` / `768p竖` / `480p横` / `768p横`，不再发送上游 `ratio`；图片按数组顺序转为 `ref_image_0`–`ref_image_8`。
- H3-self 支持本地图片 multipart：客户端重复 `image_urls` 文件字段；通过宿主 `files[].ref` 与 `parts[].fileRef` 转发，出站改为编号字段，不读取文件字节或手写 boundary。当前契约不接受文件和 URL 混传。
- 其余四个型号使用 JSON 的 `image_urls`，允许音频的型号另用 `audio_urls`，素材必须为公网 HTTPS 链接。文件可先按供应商文档通过 `/v1/uploads` 托管；本插件不自动执行上传。
- 本契约的 JSON 素材只接受 URL。H3-self 原生还支持 Base64，但本插件未开放该输入形式；也不接受原生编号字段、`metadata`、参数别名或未声明选项。
- Chovy 提示词中的 `<Audio N>` 必须有对应音频；不因缺少音频而自动重提或补素材。
- 请求实际使用宿主的渠道 `ctx.baseUrl` 和 `ctx.apiKey`，保留客户端模型身份，按映射后的模型校验能力；只在出站 body 设置 `ctx.upstreamModel`。

对外仅声明 `openai_video`：`POST /v1/videos`、`GET /v1/videos/{id}`、`GET/HEAD /v1/videos/{id}/content`。供应商同路径创建、查询及下载；下载使用上游任务 ID 并携带渠道 Bearer Key，由 New API 转发二进制，不依赖查询中的外部视频链接。

状态严格映射 `queued`、`in_progress`、`completed`、`failed`，失败原因读取 `error.message`，未声明状态返回 `UNKNOWN`。已完成但下载失败时重查原任务，不自动重新付费生成。供应商说明任务保留 24 小时，同一密钥反复整段下载同一视频会触发限流，详见原文。

## 来源与版本差异

2026-11-10 读取 [文档页面](https://openai.fit/docs)、页面实际加载的 [Markdown 正文](https://openai.fit/downloads/docs/openai.fit-api-docs.md) 及 [实时模型广场数据](https://openai.fit/api/pricing)。

- 文档正文标注更新于 2026-11-03，旧记录称 `minimax H3` 已下架；实时广场已重新列出该型号，并给出了完整参数，本插件按实时说明接入。
- 旧文档称 Spica 不收音频，实时说明已支持 1 段音频且要求同时带图，本插件按实时说明校验。
- H3-self 的实时价格也已不同于旧文档；插件不保存价格，实际以渠道配置和供应商账单为准。
- `source-document.md` 保存共用视频协议及四个旧版 MiniMax 章节；`source-models.json` 保存五个型号的实时公开说明与用量 schema。未纳入其他系列、已下架的 H3-MAX 或仅在旧前端代码中出现的型号。

公开列出不代表当前 Key 一定具备权限、额度或上游资源；上线时可使用供应商 `GET /v1/models` 核对当前 Key 的可用完整 ID。

## 构建与验证

仓库根目录执行：

```bash
bun integrations/newapi/openai-fit-minimax/build.mjs
node integrations/newapi/openai-fit-minimax/plugin.test.mjs --fixture integrations/newapi/openai-fit-minimax/newapi-host-fixture.json
go test ./integrations/newapi/openai-fit-minimax ./internal/videocontract ./internal/protocol
```

New API 宿主可重放：

```bash
new-api plugin lint openai-fit-minimax-video-1.0.2.js
new-api plugin test openai-fit-minimax-video-1.0.2.js --fixture newapi-host-fixture.json
```

实际检查结果见 `validation.json`，契约干跑结果见 `contract-dry-run.json`。检查覆盖全部五个型号的时长、清晰度与画幅组合、素材边界、Spica 音频条件、Chovy 音频引用、H3-self 编号 JSON/multipart、映射模型、轮询和下载，以及隔离 SQLite 的契约导入、持久化回读、重新注册和重复导入。

未上传或激活生产 New API 插件，未导入当前运行服务，未发送真实视频生成请求；离线通过不代表供应商鉴权、计费与成片已实测。本次没有修改前后端代码，未执行前端构建或 lint。
