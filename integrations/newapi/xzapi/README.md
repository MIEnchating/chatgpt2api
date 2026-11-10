# XZAPI StarFrame 视频接入

单文件插件：`xzapi-video-1.0.0.js`；标识 `xzapi-video`，版本 `1.0.0`。插件嵌入三个模型契约和 23 个精确模型的能力限制，不依赖外部 JSON 文件或网络加载代码。

模型列表与数量限制取自 2026-11-07 读取的 [价格页](https://api.xzapi.vip/pricing) 及其 [公开数据接口](https://api.xzapi.vip/api/pricing)，协议来自 [开发文档](https://docs.xzapi.vip/#task-status) 和 [错误码](https://docs.xzapi.vip/errors.html)。`source-models.json` 保存相关模型描述快照；价格页的列出状态不保证当前 Key 的权限、额度或供应商可用性。

## 安装

1. New API 插件管理上传 `xzapi-video-1.0.0.js` 并激活。
2. 创建“任务插件”渠道，绑定 `xzapi-video`；Base URL 使用 `https://api.xzapi.vip`，不追加 `/v1`，渠道填写 XZAPI Key。
3. 添加下面所需的精确模型名，并配置分组、令牌权限和售价。
4. 创作台导入 `contract.json`：一次导入三个启用的契约，分别覆盖 CH01、CH13、CH14。三个契约共享同一个 New API 插件。
5. 创作台的线路指向上述 New API 渠道，使用 New API 令牌。

当前工作区服务已在 2026-11-07 导入并启用这三份契约，23 个模型均已通过持久化回读与注册校验，原有 wan-3 契约保留。当前服务不必重复执行第 4 步；其他实例仍需导入。

本契约描述“创作台 → New API”的请求。XZAPI 的单复数素材转换和幂等字段由交付插件完成，因此不能把契约直接用于 XZAPI 直连，也不能用界面里的通用生成器替换此专用插件。重新构建使用本目录 `build.mjs`。

## 模型能力

| 精确模型 ID | 秒数 | 分辨率 | 图片/视频/音频上限 | 合计上限 | 供应商计费模式 |
| --- | --- | --- | --- | --- | --- |
| `1311-seedance-2-5-480p` | 4–30 | 480p | 30/0/10 | 40 | 按秒 |
| `1311-seedance-2-5-720p` | 4–30 | 720p | 30/0/10 | 40 | 按秒 |
| `1402-seedance-2-0-480p` | 4–15 | 480p | 9/3/3 | 15 | 按次 |
| `1402-seedance-2-0-720p` | 4–15 | 720p | 9/3/3 | 15 | 按次 |
| `1403-seedance-2-5-480p` | 4–12 | 480p | 9/3/3 | 15 | 按次 |
| `1403-seedance-2-5-720p` | 4–12 | 720p | 9/3/3 | 15 | 按次 |
| `ch0101-sd-2.0-480p` | 4–15 | 480p | 9/3/3 | 12 | 按秒 |
| `ch0101-sd-2.0-720p` | 5–15 | 720p | 9/3/3 | 12 | 按秒 |
| `ch0102-sd-2.0-1080p` | 4–15 | 1080p | 9/3/3 | 12 | 按秒 |
| `ch0102-sd-2.0-720p` | 4–15 | 720p | 9/3/3 | 12 | 按秒 |
| `ch0107-sd-2.5-480p` | 4–30 | 480p | 30/10/10 | 50 | 按秒 |
| `ch0107-sd-2.5-720p` | 4–30 | 720p | 30/10/10 | 50 | 按秒 |
| `ch0108-sd-2.5-720p` | 4–30 | 720p | 30/0/10 | 40 | 按秒 |
| `ch0112-sd-2.0-480p-fast` | 4–15 | 480p | 9/3/3 | 12 | 按秒 |
| `ch0112-sd-2.0-720p-fast` | 4–15 | 720p | 9/3/3 | 12 | 按秒 |
| `ch0113-sd-2.0-480p-mini` | 4–15 | 480p | 9/3/3 | 12 | 按秒 |
| `ch0113-sd-2.0-720p-mini` | 4–15 | 720p | 9/3/3 | 12 | 按秒 |
| `ch1306-sd-2.0-480p` | 4–15 | 480p | 9/0/3 | 12 | 按次 |
| `ch1306-sd-2.0-720p` | 4–15 | 720p | 9/0/3 | 12 | 按次 |
| `ch1307-sd-2.5-720p` | 4–30 | 720p | 30/10/10 | 50 | 按秒 |
| `ch1308-sd-2.0-720p` | 4–15 | 720p | 9/3/3 | 12 | 按秒 |
| `ch1309-sd-2.0-480p` | 4–15 | 480p | 9/0/3 | 12 | 按秒 |
| `ch1309-sd-2.0-720p` | 4–15 | 720p | 9/0/3 | 12 | 按秒 |

- 画幅使用文档公开的 `16:9`、`9:16`、`4:3`、`3:4`、`1:1`、`21:9`。文档未另列每个型号的画幅差异，仍以供应商实际校验为准。
- 客户端默认 5 秒、16:9，取自文档示例，不代表供应商声明了这些服务端默认值；分辨率固定为模型描述中的档位。当前契约按整数秒提供选项。
- 未公布独立总数限制的型号，合计上限取各类型上限之和；这不代表供应商承诺所有组合均可用。未公开的提示词长度、MIME 和字节数限制不作猜测。
- 当前目录没有 CH04/CH06；文档只指出这两类支持首尾帧，因此本次只接入 `references` 模式：无素材为文生视频，有素材为参考生成。不开放 `frames`、文件上传或 Base64。
- 插件只报告请求时长 `seconds` 和清晰度 `resolution` 作为计费用量，不内置价格。按次模型需在 New API 配置固定的按次价格，不能误套按秒乘数。

## 请求与转换

客户端向 New API 提交：

```json
{
  "model": "ch0101-sd-2.0-720p",
  "prompt": "参考图片中的人物缓慢向前走",
  "duration": 5,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "references": { "images": ["https://media.example.com/image.jpg"] }
}
```

插件向 XZAPI 发送同一模型与参数，并执行：

- 固定添加 `mode: "references"`。
- 从宿主 `ctx.publicTaskId` 设置 `client_task_id`，验证 1–128 个字母、数字、下划线、连字符或点号。同一网关任务重试使用相同 ID；不生成随机 ID，也不让客户端覆盖宿主的任务标识。客户端重新 POST 会创建新的网关任务，不能用来替代查询原任务。
- 客户端素材统一采用 `references.images/videos/audios` 数组；单元素在出站时转换为 `image/video/audio` 字符串，多元素保留复数。无素材时不发送 `references`。这就是当前 XZAPI 要求的数量编码，不会同时发送单数与复数字段。
- 不发送未声明的 `seconds`、音频开关、水印、随机种子。用量中的 `seconds` 与上游请求体分离。

创建为 `POST /v1/videos`，查询为 `GET /v1/videos/{id}`。`queued` 等待、`in_progress` 处理中、`completed` 完成、`failed` 失败；失败原因读取 `metadata.fail_reason`，`unknown` 或未声明状态返回 `UNKNOWN`。

下载使用 Bearer 鉴权的 `GET /v1/videos/{id}/content`，视频二进制由 New API 宿主转发。客户端 HEAD 同样向供应商执行其文档声明的 GET，由宿主省略响应体。没有假定结果为 CDN 签名地址。供应商若发生跨域鉴权重定向，需进一步确认下载协议，不能关闭宿主保护来绕过。

文档规定：重复进行中/完成的 `client_task_id` 返回 409；取回失败可能返回 410。本插件保留错误，不在这些错误下自动创建另一个业务任务，也不自动重复付费生成。

契约轮询间隔 5 秒、等待预算 1800 秒是客户端配置；New API 任务调度和超时以宿主设置为准。

## 构建与验证

在仓库根目录执行：

```bash
bun integrations/newapi/xzapi/build.mjs
node --test integrations/newapi/xzapi/plugin.test.mjs
go test ./internal/httpapi -run '^TestXZAPIVideoContractsImportAndMapReferenceInputs$' -count=1
```

New API 宿主可重放：

```bash
new-api plugin lint xzapi-video-1.0.0.js
new-api plugin test xzapi-video-1.0.0.js --fixture newapi-host-fixture.json
```

本次 50 项 Node 测试通过；New API 本地插件运行时 lint 及 437/437 项回放通过。覆盖全部 23 个模型的每个整数时长、默认值、素材单复数、类型/合计上限、缺失幂等 ID、模型映射、状态和下载。契约干跑覆盖 23 模型 × 2 模式；Go 契约导入和请求映射测试通过；重复构建的插件 SHA-256 一致。宿主源码版本与结果见 `validation.json`。

未上传或激活生产 New API 插件，未发送真实生成请求。本地通过不代表供应商鉴权、计费或视频产出已实测。
