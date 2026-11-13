# Hi.Run H3 视频

依据 [Hi.Run 开发文档](https://hi.hi.run/developers) 的 OpenAI 兼容视频接口制作。交付物包含可导入的视频契约和 NewAPI 可上传的独立插件。

## 文件

- `contract.json`：导入本项目的视频契约，含 `h3-video` 与 `h3-video-flex`。
- `hirun-video-1.0.2.js`：NewAPI 单文件任务插件，标识 `hirun-video`，版本 `1.0.2`。
- `contract-dry-run.json`：本地契约干跑结果。

## 配置

1. 在 NewAPI 插件管理中上传并启用 `hirun-video-1.0.2.js`。
2. 创建“任务插件”渠道，绑定插件标识 `hirun-video`。
3. Base URL 填 `https://hi.hi.run/api/openai/v1`，渠道 Key 填 Hi.Run API Key。
4. 添加模型 `h3-video` 和/或 `h3-video-flex`，设置分组、权限及售价。
5. 在本项目导入 `contract.json`。按自己的计费规则配置 NewAPI 售价；插件报告请求秒数，不内置价格。

插件调用 `POST /videos` 和 `GET /videos/{id}`。契约输入的标准 `duration` 会由插件转换为 Hi.Run 的 `seconds`；比例与清晰度组合为文档要求的宽×高 `size`，用量按 `seconds` 和 `resolution` 两个维度上报。文件参考图以重复的 multipart `input_reference` 文件字段提交，纯文本请求使用 JSON。下载时先用渠道 Bearer Key 查询任务，再从 `sparkcine.outputs[0].download_url` 或 `outputs[0].download_url` 读取临时签名地址，并以无鉴权方式下载。

Hi.Run 的 content 接口会经过网关和跨域跳转，插件不把它作为 New API 的鉴权内容代理入口。签名地址由任务查询响应刷新，下载失败时可重新查询任务获取新地址。

契约开放 `h3-video` 的 4–30 秒，以及 `h3-video-flex` 的通用 4–15 秒范围。Hi.Run 对 flex 的 16–30 秒另有限定条件，因此插件不开放该条件性范围。尺寸选项是常见宽高组合，Hi.Run 会映射到最接近的画幅和可覆盖短边的分辨率；账号实际模型权限与参数约束以 Hi.Run 的 `/api/open/v1/models` 返回为准。

H3 Frames 和 H3 原生多模态 `content[]` 属于 `/api/h3` 的另一套请求协议，本插件没有声明支持。文档未明确 OpenAI 视频端点接受图片 URL 或 Base64，因此此契约仅开放 multipart 图片文件，不将 URL/Base64 宣称为此端点支持的方式。

## 验证

价格页注明视频最低消费 20 积分，成功使用优化提示词时另加 5 积分；NewAPI 插件的用量钩子只能报告请求秒数与清晰度，不能从请求推导供应商最终最低扣费或是否实际使用了优化结果。因此 NewAPI 售价须按上游实际账单规则设置，插件不会把固定最低消费或优化附加费错误换算为时长。

使用 `bun run integrations/newapi/hirun/build.mjs` 重新生成插件，使用 `node --test integrations/newapi/hirun/plugin.test.mjs` 运行针对性回归。测试覆盖 JSON 创建、multipart 图片、时长与清晰度映射、任务状态和内容下载请求；没有调用 Hi.Run 上游，也没有验证账号权限、真实计费或生产下载网络策略。
