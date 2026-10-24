# Dramaya Seedance A 视频契约

契约已写入内置配置 [video_model_contracts.json](../internal/protocol/video_model_contracts.json)，以一条契约包含 `seedance2.0-A` 和 `seedance2.5-A`，并通过 `model_profiles` 分别声明能力。独立 JSON 样例：[newapi-seedance-a-contracts.json](examples/newapi-seedance-a-contracts.json)。

参数依据用户提供的 Dramaya 当前 Key 公开目录摘录。该摘录列出 `duration`、`resolution`、`aspect_ratio` 以及 `images`、`first_frame`、`last_frame`、`videos`、`audios` 素材上限。两个型号的输入字段相同，但时长与素材数量上限不同，因此分开声明。

| 模型 | 时长 | 默认值 | 分辨率 | 画幅比例 | 图片 / 视频 / 音频上限 |
| --- | --- | --- | --- | --- | --- |
| `seedance2.0-A` | 4–15 秒 | 4 秒 | 480p、720p、1080p | 16:9、9:16、1:1、4:3、3:4、21:9、Auto | 9 / 3 / 3 |
| `seedance2.5-A` | 4–30 秒 | 4 秒 | 480p、720p、1080p | 同上 | 30 / 10 / 10 |

应用侧通过 New API 的 `/v1/videos/{task_id}/content` 下载视频并携带中转鉴权。配套插件在供应商侧查询任务取得签名地址，再不带 Key 下载。

素材采用公网 URL。应用传给插件的字段为 `first_frame_url`、`last_frame_url`、`image_urls`、`reference_video_urls`、`reference_audio_urls`；专用插件将它们转换为 Dramaya 文档要求的 `references`（`type`、`role`、`source`）。不要用通用生成器重新导出的文件覆盖这个专用转换。

2.0-A 普通参考素材合计最多 12 份；首尾帧必须成对，自动使用 `Auto` 比例，不能混普通参考素材。2.5-A 普通参考素材合计最多 50 份，不支持首尾帧。参考模式不强制包含图片。当前 Key 摘录中各素材单文件上限为 100 MiB；平台上传入口另有自己的限制。

内置模板只在数据库尚未初始化时加载；已有实例需要通过契约管理服务发布，不能把修改模板视为已经写入实例。
## 生成 New API 插件

New API 插件：[dramaya-seedance/plugin.js](../integrations/newapi/dramaya-seedance/plugin.js)。下载文件版本为 `1.0.1`，包含上述专用素材转换。生成文件不包含 Dramaya Key，New API 渠道中再填写 Key，并将渠道绑定到 `dramaya-seedance`。

“读取当前 Key 的公开参数”是 Dramaya 文档中的目录 API 能力（`GET /v1/media/models`），本次没有收到 Key，因此没有发起带凭据的在线目录请求。当前契约只依据随请求提供的公开参数摘录生成。不要把 Key 粘贴到契约 JSON、插件源码或文档中。

New API 插件生成器不会替代实际供应商验证。尤其应核对创建响应、轮询状态、结果 URL 字段、下载鉴权和素材模式是否与当前 Key 返回值一致。
