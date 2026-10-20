# Dramaya Grok 视频契约

来源：[视频 API 文档](https://playground.dramaya.us/developers#videos)（2026-10-20 读取）及用户提供的当前 Key `/v1/media/models` 公开参数。

导入文件：[`examples/dramaya-grok-video-contract.json`](examples/dramaya-grok-video-contract.json)。文件包含一条契约，两个精确模型共用创建、查询、下载和请求字段映射，通过 `model_profiles` 分别声明完整能力。

| 模型 | 时长 | 宽高比 | 分辨率 | 参考素材 |
| --- | --- | --- | --- | --- |
| `grok-imagine-video` | 1–15 秒，默认 8 秒 | 16:9、9:16、1:1、4:3、3:4、3:2、2:3 | 480p、720p，默认 480p | 当前 Key 未声明 |
| `grok-imagine-video-1.5` | 1–15 秒，默认 8 秒 | 同上，默认 16:9 | 480p、720p、1080p，默认 480p | 最多 1 张参考图 |

## 请求与任务

- 创建：`POST /v1/videos`，JSON 字段 `model`、`prompt`、数字 `duration`、`aspect_ratio`、`resolution`。
- 1.5 的参考图片使用 `image_urls` 数组；未声明首尾帧、视频或音频素材，不展示这些输入。
- 查询：`GET /v1/videos/{task_id}`，读取 `id`、`status`、`progress`。
- 下载：`GET /v1/videos/{task_id}/content`，使用同一上游 Key。每 5 秒查询一次，等待预算 1800 秒。
- 目录中的 `generation` / `edit` 表示参数的适用场景，不单独证明支持视频编辑，也不作为 `generation_mode` 发送。
- 没有公开音频生成、水印开关，所以不发送对应字段。`audio_control=none` 仅表示本项目不提供音频参数，不承诺上游视频没有音轨。
- 文档未声明提示词上限；5000 字符是本项目契约默认的本地限制。

文档的视频服务地址是 `https://video.dramaya.us`。契约只保存路径，实际请求仍使用选定 Key/线路的地址；导入不会修改中转地址或凭据。

## 参考图片

当前 Key 对 1.5 声明 PNG、JPEG、WebP，单张最大 20 MiB（20971520 字节）。本契约使用公开 HTTPS URL 素材。当前契约的 URL 模式不负责调用 Dramaya 的文件上传与容量预约接口，也不读取远程文件以验证大小和 MIME；这些限制由上游校验。不得把本地路径、Base64 或 multipart 当作此接口已支持的输入。

## 模型能力配置

`model_profiles` 每项包含 `model`、`capability`、`validation`、`generation`、`rules`。每个配置完整替换对应模型的能力；接口配置保持共用。精确模型 ID 必须在 `models` 中，重复项、通配符和未声明模型会被拒绝。

管理页通过“当前配置的模型能力”切换并编辑各模型。未单独配置的模型使用顶层通用能力。预览、创作参数和实际提交均按模型解析；任务保存解析后的能力快照与契约版本。
