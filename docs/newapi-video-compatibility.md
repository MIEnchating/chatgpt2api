# New API 视频接入核验

核验日期：2026-10-20。目标为官方 `QuantumNous/new-api`，GitHub 最新发布 `v1.0.0-rc.45`（预发布版本），commit `6cf0d90b5ff27f901697dddd61e0c28aba8efefc`；同时比对 main `32e587406c6ebe891f18ab9aeb2f4a1f6b7b9e14`，相关视频插件与公开接口没有变化。

## 当前配置与前置条件

本次工作区配置有四个视频模型。下表核验的是官方插件的请求转换，模型列表只控制可选项，实际创建任务还需要启用匹配的视频契约。

| 配置模型 | New API 插件 | 核验结果 | 接入条件 |
| --- | --- | --- | --- |
| `grok-imagine-video` | `xai` | 文生、首尾帧、参考图请求转换通过 | 启用任务插件、配置渠道与模型权限 |
| `grok-imagine-video-1.5` | `xai` | 同上；参考图模式限制为 480p/720p | 同上 |
| `seedance2.0` | `doubao` | 请求转换通过；测试显式映射至 `doubao-seedance-2-0-260128` | 简称不是插件声明的完整模型 ID，须配置并核对渠道映射 |
| `seedance2.5` | `doubao` | 请求转换通过；测试显式映射至 `doubao-seedance-2-5-260628` | 同上 |

Seedance 的映射是官方 Doubao 插件的测试条件，并非所有聚合渠道的接入要求。本项目始终原样发送用户选择的模型 ID，不自动补全或改写名称。使用聚合渠道时，应以该渠道实际接收的字段为准，不能仅凭模型简称套用原生插件契约。

本机现有 New API 容器使用 `mienvirtuoso/new-api:latest` 镜像；该标签不能证明它与本次核验的官方 commit 一致。只读检查确认，运行服务使用 PostgreSQL，四个模型配置在 OpenAI 类型的聚合渠道中，没有模型映射，运行时插件列表不包含 xAI。因此，本地另一份空 SQLite 数据库不能用于判断目标渠道是否存在，官方插件测试通过也不代表当前聚合接口已接通。本次未修改数据库连接、渠道、运行时契约或容器版本。

可导入样例位于 [newapi-video-contracts.json](examples/newapi-video-contracts.json)。两个 Grok 契约标记为启用；两个 Seedance 契约标记为禁用，核对目标渠道后再启用。该文件没有自动写入运行时数据库。

Seedance 样例只提供保守的起始选项：5/8/10 秒、480p/720p、三种画幅，参考图片/视频/音频各最多一个。这不是厂家的完整能力表；最高分辨率、最长时长、素材文件大小和累计时长限制应按实际映射的模型及厂家文档设置。插件能力表显示普通 2.0 和 2.5 的时长、清晰度上限不同，不能合并为一个不加限制的契约。

## 公开接口和产物

最新版 New API 已采用任务插件架构，包含 xAI 与 Doubao 插件：

- 创建：`POST /v1/videos`。
- 查询：`GET /v1/videos/{task_id}`，使用公开 `id`，状态为 `queued`、`in_progress`、`completed`、`failed`。
- 内容：`GET /v1/videos/{task_id}/content`，携带中转 Bearer Key。标准查询不保证提供 `video_url`。

样例使用 `artifact.mode=task_content`、`artifact.auth=relay`，本项目下载并保存视频。xAI 可能把已结算但被审核拦截的任务表示为 `completed`，同时返回 `error.code` 和 `error.message`；本项目会保留这个错误，不再请求不存在的产物。

源码依据：[公开路由](https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/pkg/jsplugin/routing.go)、[任务协议路由](https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/router/task-plugin-protocol-router.go)、[宿主响应处理](https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/relay/channel/task/jsplugin/adaptor.go)。

## 字段和素材

### Grok

`xai-videos` 使用 `duration`、`aspect_ratio`、`resolution`、`generate_audio`；首尾帧为 `image`、`last_frame`；普通参考图片为 `reference_images`。New API 插件负责包装成 xAI 所需的对象。

样例采用 URL 素材，普通参考图最多七张，首尾帧与普通参考图互斥。1.5 支持的 1080p 不适用于参考图生成。视频编辑/续写走独立接口，不能声明成普通生成接口的参考视频能力。官方 multipart 的单个 `input_reference` 文件不能表达任意多素材及首尾帧顺序。

源码依据：[xAI 插件](https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/plugins/tasks/xai/plugin.js)。

### Seedance

`volcengine-video` 对接 New API `/v1/videos`：时长为 `seconds`，其他参数放在 `metadata.ratio`、`metadata.resolution`、`metadata.generate_audio`、`metadata.watermark`。

契约中的素材字段使用 `first_frame_url`、`last_frame_url`、`reference_image_urls`、`reference_video_urls`、`reference_audio_urls`。驱动将其转换为 `metadata.content`，每项包含 `type`、媒体 URL 对象和 `role`，保留首帧、尾帧、参考图片、参考视频、参考音频的语义。`metadata.content` 为驱动保留路径，不能映射其他参数。此驱动只支持 URL 素材，New API Doubao 插件拒绝文件上传。

`ark-seedance` 则用于直连方舟原生接口；它使用不同的创建、查询路径与状态枚举，不应作为 New API `/v1/videos` 的替代配置。

源码依据：[Doubao 插件与模型能力表](https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/plugins/tasks/doubao/plugin.js)。

### 现有 MiniMax 模板

内置 `MiniMax H3 v1.8` 模板对应既有聚合商约定，不是最新版官方 New API `hailuo` 插件模板。当前配置的四个模型都不能套用它。官方插件使用 `MiniMax-H3` 等 ID，H3 画幅读取 `metadata.ratio`（自适应值为 `adaptive`），首尾帧读取 `metadata.first_frame_image` / `metadata.last_frame_image`，参考视频、音频也有独立字段；普通参考图涉及带类型和角色的 `metadata.content`。仅修改模型名会丢参数或丢素材。

源码依据：[Hailuo 插件](https://github.com/QuantumNous/new-api/blob/6cf0d90b5ff27f901697dddd61e0c28aba8efefc/plugins/tasks/hailuo/plugin.js)。

## 验证方式与边界

`go test ./internal/httpapi -run TestNewAPIVideo` 校验可导入契约、实际请求映射，并用 HTTP 测试服务器覆盖排队、进度、完成、带认证内容下载、产物落盘、完成但审核失败。

`node scripts/check-newapi-video-contracts.mjs /path/to/new-api` 加载指定 checkout 的真实 JS 插件，执行请求解码与厂家请求构造。共享 fixture 覆盖四个模型的文生、首尾帧、参考素材，共十二项；Seedance fixture 显式声明测试用上游模型映射。

上述检查不调用付费生成服务，不验证真实账号余额、厂家授权、网络可达性、渠道映射是否已部署或生成质量。模型与渠道配置完成后，仍需在目标环境进行一次真实生成验收。

## 二次回归检查

进一步检查已覆盖并修复以下边界情况：

- 管理端请求预览与实际提交共用默认值、素材约束和参数校验，强制规则仅执行一次；方舟原生请求也使用规范化后的参数。
- 不同生成模式复用同一素材字段时，仅解析当前模式的字段，避免多张参考图被当成单张首帧而截断，也避免将普通参考图误转换成首帧。
- 前端隐藏时长后按服务端将使用的默认时长校验；显式首尾帧 URL 不再重复计入普通参考图。
- 前端校验与请求构造共用一次显示规则计算结果，避免隐藏字段恢复默认值后再次触发显示规则，造成提交前误报或请求字段与校验内容不一致。
- 强制参数规则只允许 `duration`、`size`、`resolution`、`generate_audio`、`watermark`。素材的有无和数量必须来自真实输入，不允许通过强制值修改。
