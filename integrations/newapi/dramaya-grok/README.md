# Dramaya Grok 视频任务插件

上传文件：[`plugin.js`](plugin.js)。插件标识 `dramaya-grok`，版本 `1.0.1`。

`plugin.js` 已补充详细中文注释，涵盖插件调用流程、两个模型的能力差异、参数校验、任务 ID 与 Key 的区别、幂等提交、状态转换、计费用量，以及下载 502 的原因和签名地址处理。此次仅完善注释，功能版本仍为 `1.0.1`，已有部署无需为注释更新而重新上传。

1.0.1 修复生成成功后的下载 502：先使用 Dramaya Key 查询任务以取得新的签名结果地址，然后以 `credentialless` 方式下载。New API 会拒绝带凭据的跨域产物跳转；旧版直接请求 `/content` 的方式会触发这一限制。升级时上传此版本并激活，渠道继续绑定同一个插件标识。已完成任务可以重新请求下载，无需重新生成。

这是 New API 的 JavaScript 任务插件，与创作台的 JSON 视频契约是两个不同的配置文件。两个 Grok 模型共用此插件，各自保留参数限制。

## 安装与渠道配置

1. 在 New API 管理后台打开任务插件管理，上传 `plugin.js`。若上传后显示“需激活”，点击激活，并确认插件启用。
2. 新建渠道，或修改原“视频测试”渠道，在提供商/插件选择器中选择 **Dramaya Grok 视频**。其底层渠道类型为 **Task Plugin（61）**，绑定标识为 `dramaya-grok`。
3. 上游地址填写 `https://video.dramaya.us`，不要追加 `/v1`。密钥填写 Dramaya 签发的 Key。
4. 添加精确模型名 `grok-imagine-video` 和 `grok-imagine-video-1.5`，不设置模型映射。分组选择 `视频-测试`，启用渠道。
5. 在模型定价中配置两个模型的实际售价。若与 xAI 插件共享模型，选择 Dramaya 对应的提供商定价；不要直接套用引用了 xAI 专有字段的计费表达式。
6. 提供给创作台的 New API 令牌也选择 `视频-测试` 分组；若启用了模型限制，允许这两个模型。创作台继续使用 New API 的地址、New API 令牌和已经配置的 Dramaya 视频契约。

需要支持 Task Plugin API v1、`openai_video` 和模型级 `usageProfiles` 的当前 New API 构建。上传后若提示未知元数据字段，需升级 New API；不能通过删除模型差异配置来假装已验证旧版兼容。

本插件不占用 Sora 或 xAI 的渠道类型，不需要停用 xAI 插件。必须将 Dramaya 渠道绑定到本插件；只在 Sora 渠道中添加 Grok 模型不会完成绑定。

## 参数

| 字段 | grok-imagine-video | grok-imagine-video-1.5 |
| --- | --- | --- |
| `duration` | 整数 1–15，默认 8 | 相同 |
| `aspect_ratio` | 16:9、9:16、1:1、4:3、3:4、3:2、2:3；默认 16:9 | 相同 |
| `resolution` | 480p、720p；默认 480p | 480p、720p、1080p；默认 480p |
| `image_urls` | 当前 Key 未声明参考图，不接受非空图片列表 | 最多 1 张公开 HTTPS 图片 URL |

此插件选择与当前创作台契约一致的 `duration` 数字字段，未实现 `seconds`、`size`、`image` 等别名转换。只接受 JSON。模型与提示词必填；未声明的字段会明确报错，避免素材被悄悄丢弃。

1.5 参考图的 PNG/JPEG/WebP、20 MiB 限制由 Dramaya 校验。本插件不主动下载参考图检查 MIME 或大小，不提供 multipart、Base64、文件上传、视频编辑、remix、首尾帧、参考视频、参考音频、音频开关或水印开关。公开参数中的 generation/edit 标签不等于已提供视频编辑接口。

```json
{
  "model": "grok-imagine-video-1.5",
  "prompt": "蓝色陶瓷杯放在木桌上，镜头缓慢推进",
  "duration": 8,
  "aspect_ratio": "16:9",
  "resolution": "720p",
  "image_urls": ["https://cdn.example.com/cup.png"]
}
```

示例图片地址为占位值，实际调用须替换为可访问的图片地址。

## 创建、查询与下载

- 客户端创建：向自己的 New API 发送 `POST /v1/videos`，使用 New API 令牌。
- 客户端查询：`GET /v1/videos/{id}`，使用创建响应中的 New API 公共任务 ID。
- 客户端下载：`GET /v1/videos/{id}/content`，使用同一 New API 令牌；也支持 HEAD。Range 处理由 New API 宿主负责。
- 插件内部向 Dramaya 使用其 Key，并使用 Dramaya 返回的上游任务 ID 查询与下载。
- 每次下载先对 Dramaya 的任务查询地址执行同源鉴权 GET，从 `video_url` 或文档声明的 `data[].url` 获取当前签名结果地址，再返回不带任何凭据的下载请求。不会携带 Dramaya Key 请求 CDN，也不使用已保存的过期地址。后续无凭据重定向和 Range 转发由 New API 宿主负责。
- `cancel_requested` 继续等待；`failed`、`cancelled`、`expired` 为终止失败；未知状态明确返回 UNKNOWN，交由宿主的轮询失败策略处理。插件不提供取消提交接口。
- 创建时以 New API 公共任务 ID 生成稳定的 `Idempotency-Key`，覆盖同一网关任务内部的重试。客户端重新 POST 会产生新的网关任务，不保证跨 POST 去重；收到任务 ID 后应继续查询。

## 计费

插件提供 `seconds`（已验证的请求时长）和 `resolution`（已验证的清晰度）作为计费用量字段，不内置任何价格。按次定价保持按次，不额外乘以时长；按秒定价需在后台明确配置对应的计费规则。

公开文档未给出 Grok 完成响应的权威计费用量字段，因此插件不把输出文件大小、进度、未声明的 `usage` 或报价快照当作实际费用。New API 的任务结算与退款遵循宿主规则，不承诺与 Dramaya 的上游账单完全一致。

## 验证与来源

开发验证使用 Node 回归测试与 New API 自身 JavaScript 插件运行时回放，不需要真实 Key，也不创建收费任务。调用 `utils.fetch` 的下载用例需通过宿主 `WithFetcher` 注入响应测试；官方 CLI dry-run 不提供网络查询能力。上传、真实渠道选择、上游权限、余额及一次完整生成仍需在目标部署中验证。

```bash
node --test integrations/newapi/dramaya-grok/plugin.test.mjs
node integrations/newapi/dramaya-grok/plugin.test.mjs --fixture /tmp/dramaya-grok-fixture.json
new-api plugin lint integrations/newapi/dramaya-grok/plugin.js
new-api plugin test integrations/newapi/dramaya-grok/plugin.js --fixture /tmp/dramaya-grok-fixture.json
```

- 接口文档：<https://playground.dramaya.us/developers#videos>，2026-10-21 核对
- 模型能力：用户提供的当前 Key 公开参数，2026-10-20
- 宿主协议：New API `docs/plugin-api/v1.md`
