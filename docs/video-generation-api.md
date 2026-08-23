# 视频生成参数约束

视频生成请求由创作台或无限画布提交到 `/api/creation-tasks/video-generations`，后端校验后再转发到上游 `/v1/videos`。后端校验是最终边界，前端选项只用于减少无效输入。

## MiniMax H3

依据 MiniMax 官方 [Video Generation V2](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) 与 [Video Generation Guide](https://platform.minimax.io/docs/guides/video-generation)：

- 模型名为 `MiniMax-H3`，提示词必填且最多 7000 个字符。
- 时长为 4-15 秒，清晰度仅支持 `768P`、`2K`。
- 文生视频必须使用 `21:9`、`16:9`、`4:3`、`1:1`、`3:4` 或 `9:16`，不能使用自适应画幅。
- 首帧图生视频接受一张本地图片，画幅由该图片决定。
- 多模态参考生视频可组合使用最多 9 张参考图片、3 个参考视频和 3 个参考音频；图片与首帧/尾帧图生视频不能混用。
- 视频生视频在官方协议中属于 `reference-to-video`，只传 `reference_video_urls` 即为视频生视频；它不是独立的 `video-to-video` 生成模式。
- 多模态参考 URL 在产品入口仅接受不超过 2083 个字符、无账号信息且主机不是 localhost、私网或保留地址的 `http://` 或 `https://` 地址。MiniMax 官方也支持 `mm_file://` 和 Data URL，但当前统一中转把这些字段校验为短 URL；长 Base64 会触发 URL 长度 422，因此不在兼容入口开放。
- 参考视频支持 MP4/MOV、单个不超过 50 MB、2-15 秒，最多 3 个且总时长不超过 15 秒；参考音频支持 WAV/MP3、单个不超过 15 MB、2-15 秒，最多 3 个且总时长不超过 15 秒。完整请求不超过 64 MB。
- 首帧图支持 PNG、JPEG、WebP，最大 30 MB，宽高均为 256-5760 像素，宽高比为 2:5 到 5:2。
- H3 V2 创建接口没有水印开关，因此不会发送 `aigc_watermark`。

MiniMax 官方 V2 协议把自适应画幅写作 `adaptive`。当前上游 `/v1/videos` 的 H3 兼容请求模型把同一语义写作 `auto`，因此仅在中转边界进行 `adaptive -> auto` 转换；产品内部和官方约束说明仍使用 `adaptive`。

生成模式映射：

| 产品输入 | 中转 `generation_mode` | MiniMax 官方 V2 语义 |
| --- | --- | --- |
| 只有提示词 | `text-to-video` | `content` 仅含 `text` |
| 提示词和一张首帧图 | `image-to-video` | `image_url.role=first_frame` |
| 图片、视频或音频参考 URL | `reference-to-video` | `reference_image` / `reference_video` / `reference_audio` |

首帧图片的 Base64 Data URL 不作为 URL 字符串传给中转。服务会校验图片后，将其转换为 multipart 的 `input_reference` 文件字段，避免 URL 长度校验失败。多模态参考则使用独立 URL 数组，不会压缩成首帧 `input_reference`。

## 图片编辑参考输入

当前图生图/图片编辑入口不要求公网 URL。浏览器会上传本地图片文件到 `/api/creation-tasks/image-edits`，后端再以 multipart 或厂商要求的内联格式转发。只有厂商接口明确声明为 URL 的参考字段才需要公网地址；本节 H3 多模态参考 URL 属于这种情况。

## Seedance（即梦）

依据火山引擎官方 [创建视频生成任务](https://www.volcengine.com/docs/82379/1520757)：

- `doubao-seedance-2-5-260628`：`duration` 为 4-30 秒或 `-1`，分辨率为 `480p`、`720p`、`1080p`。
- Seedance 2.0 标准版：`duration` 为 4-15 秒或 `-1`，分辨率为 `480p`、`720p`、`1080p`、`4k`。
- Seedance 2.0 fast/mini：`duration` 为 4-15 秒或 `-1`，分辨率仅为 `480p`、`720p`。
- Seedance 1.5 pro：`duration` 为 4-12 秒或 `-1`；Seedance 1.0 系列为 2-12 秒且不支持 `-1`。
- 画幅为 `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`、`adaptive`。
- 单张参考图必须小于 30 MB，宽高比为 2:5 到 5:2。当前产品入口只建模一张首帧图，因此没有开放官方全模态参考任务的多图、视频和音频输入。
- 2.5、2.0 系列和 1.5 pro 支持 `generate_audio`；所有已识别版本支持 `watermark`。

模型能力按明确版本识别。自动获取到但尚未录入规则的新 Seedance 型号不显示画幅和清晰度选项，由上游使用默认值，不会被猜测成 2.0 或 2.5。

## Kling（可灵）

依据可灵官方 [Kling 3.0 Text to Video](https://app.klingai.com/global/dev/document-api/api/video/3-0-omni/text-to-video) 和同版本 Image to Video 定义：

- 提示词最多 3072 个字符。
- 时长为 3-15 秒，画幅为 `16:9`、`9:16`、`1:1`，分辨率为 `720p`、`1080p`、`4k`。
- 音频枚举为 `native`、`off`；水印由 `options.watermark_info.enabled` 控制。
- 参考图仅支持 JPG/JPEG/PNG，最大 50 MB，宽高均不少于 300 像素，宽高比为 1:2.5 到 2.5:1。
- 可灵直连接口支持首帧加可选尾帧；当前产品入口只上传一张首帧，因此没有显示尾帧控制。
- 图生视频的输出画幅由首帧决定，中转请求不会发送文生视频专用的 `aspect_ratio`。

Kling 1.x/2.x 仍使用旧版兼容选项（5 秒或 10 秒、`720p`/`1080p`），不会套用 3.0 的 `4k` 和连续时长规则。

## Grok

依据 xAI 官方 [Video Generation](https://docs.x.ai/developers/model-capabilities/video/generation)：

- 时长为 1-15 秒。
- 画幅为 `1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3`。
- 通用模型支持 `480p`、`720p`；`1080p` 仅支持 `grok-imagine-video-1.5`。
- xAI 视频接口不提供音频或水印开关，因此不会向上游发送这两个字段。

## MiniMax Hailuo v1

依据 MiniMax 官方 Video Generation v1 模型说明：

- Hailuo 2.3 支持 6 秒或 10 秒；10 秒仅支持 `768P`，6 秒支持 `768P`、`1080P`。
- Hailuo v1 接口没有独立画幅参数。
- `MiniMax-Hailuo-2.3-Fast` 和 `I2V-*` 模型必须提供首帧参考图。
- 水印字段映射为 `aigc_watermark`。

## Sora 2

依据 OpenAI 官方 [Video generation with Sora](https://developers.openai.com/api/docs/guides/video-generation) 与 [Sora 2 prompting guide](https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide#api-parameters)：

- `sora-2` 支持 `1280x720`、`720x1280`。
- `sora-2-pro` 额外支持 `1792x1024`、`1024x1792`、`1920x1080`、`1080x1920`。
- 时长仅支持 4、8、12、16、20 秒，上游字段按官方字符串枚举发送。
- `/v1/videos` 使用 `size` 指定尺寸，不发送独立的 `resolution`、`duration`、音频开关或水印字段。
- `input_reference` 只接受一张首帧图，图片尺寸必须与请求的 `size` 完全一致。

## 中转兼容边界

本项目调用的是统一中转 `/v1/videos`，不是分别直连每家厂商。请求会保留统一接口需要的 `model`、`prompt`、`duration`/`seconds`、`size`，并按厂商添加扁平兼容字段：

- Seedance：`ratio`、`resolution`、`generate_audio`、`watermark`。
- Kling：`aspect_ratio`、`resolution`、`sound`、`watermark`；其中 `sound` 对应官方 `settings.audio` 的 `native`/`off` 语义。
- Grok：`aspect_ratio`、`resolution`。
- Hailuo：`resolution`、`aigc_watermark`。

Seedance、Kling、Grok 和 Hailuo 的非通用参数还会写入 `metadata`，供 NewAPI 类型的兼容中转读取。不会把可灵直连接口的 `settings`/`options` 对象原样发送给统一 `/v1/videos`，否则会破坏该中转协议。H3 是单独的兼容模式：首帧图使用 multipart `input_reference`，多模态参考使用 `reference_*_urls` 数组和 `generation_mode=reference-to-video`。

## 维护要求

新增或更新视频模型时，必须同时完成：

1. 核对厂商当前官方 API 文档，不根据模型名称或其他聚合平台猜测参数。
2. 更新 `web/src/lib/video-model-capabilities.ts` 的可选项。
3. 更新 `internal/httpapi/routes.go` 的后端约束。
4. 更新 `internal/httpapi/relay.go` 的上游字段映射。
5. 为枚举、跨字段组合、生成模式和文件输入补充测试。
