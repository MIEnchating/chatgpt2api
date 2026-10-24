# Dramaya Seedance A New API 插件

本目录包含基于视频契约生成器并加入 Dramaya 素材转换的一份 Task Plugin API v1 插件：

- [Seedance A 插件](plugin.js)，插件标识 `dramaya-seedance`。

插件声明 New API 的 `openai_video` 协议，调用 Dramaya `https://video.dramaya.us` 的 `/v1/videos` 创建、查询视频任务，并从查询响应中的 `video_url` 或 `data[0].url` 获取签名下载地址。2.0-A 和 2.5-A 共用插件，但在 `usageProfiles` 与请求校验中保留独立能力。插件源码不包含 Key；在 New API 渠道配置 Dramaya Key。

## 安装

1. 在 New API 的任务插件管理中上传 `plugin.js` 并激活。
2. 创建 Task Plugin 渠道并绑定 `dramaya-seedance`。
3. Base URL 填写 `https://video.dramaya.us`，渠道 Key 填写 Dramaya Key，并添加精确模型 ID `seedance2.0-A`、`seedance2.5-A`。
4. 为两个模型设置价格和分组，并在目标渠道完成真实请求验证。

两种型号共用创建、查询和下载协议，模型能力由插件 profile 区分：2.0-A 时长上限 15 秒，素材上限为 9 张图片、3 个视频、3 个音频；2.5-A 时长上限 30 秒，素材上限为 30 张图片、10 个视频、10 个音频。插件对外接收 `duration`、`aspect_ratio`、`resolution`、`first_frame_url`、`last_frame_url`、`image_urls`、`reference_video_urls` 和 `reference_audio_urls`，提交供应商前将素材转换为带 `type`、`role`、`source` 的 `references` 数组。本地素材以公网 URL 传递。2.0-A 普通素材合计最多 12 份，首尾帧必须成对且比例为 Auto；2.5-A 合计最多 50 份，不支持首尾帧。

契约及插件基于用户提供的当前 Key 公开参数摘录生成。没有收到 Key，因此未在线请求 `GET /v1/media/models`；插件干跑也不代表供应商实际请求已验证。

版本 `1.0.1` 修正了素材字段、首尾帧规则和运行中/取消/过期状态处理。应用侧契约通过 New API content 端点下载，供应商侧使用签名 URL。通用生成器不会自动生成本文件的 Dramaya 专用素材转换，重新生成后必须保留该转换并执行干跑。
