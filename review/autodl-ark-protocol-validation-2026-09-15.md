# AutoDL 与方舟原生协议验证记录

验证日期：2026-09-15。实现沿用 Go/Vite、Cookie 身份、统一 creation tasks 和已保存自定义 API 线路。

## AutoDL 公共元数据

本次实际读取 `https://autodl.art/api/v1/comfyui/workflows`，使用 POST JSON 分页参数 `page_index` 与 `page_size`。成功响应为 `code: Success`，`data` 包含 `list` 和 `max_page`。目录没有 `kind` 字段，因此工作流详情按输入规则判断音频或视频能力。

读取了 `minimax_h3_zm_u24`、`minimax_h3_b99_002` 和 `indextts2-v1` 的公开详情；没有提交生成请求或使用付费凭据。

- H3 首尾帧与多素材工作流使用整数 `duration`，实际范围为 1–15 秒，默认 5 秒。
- 首尾帧使用 `first_frame` / `last_frame`，多素材使用 `ref_image_N`、`ref_audio_N`。
- 部分媒体规则含内部占位默认值。客户端不发送内部文件路径；可选素材缺省交由上游处理，必填素材仍要求实际 URL。
- `resolution` 使用可读枚举标签，例如清晰度加横竖画幅，界面保留上游选项，不把它猜成单一 `720p`。
- IndexTTS 使用 `prompt_text`、`prompt_simple` 和情感参数，文本上限为 2048 字符。数值范围、枚举、布尔值和字符串长度均按实际规则校验。

原始 CDN 默认素材地址未保存到仓库。

## 方舟 Seedance

自定义视频线路提供“火山方舟 Seedance 原生协议”。标准 API Base URL 使用 `/api/v3`，Agent Plan 使用 `/api/plan/v3`；两者均在所填基础地址下调用 `/contents/generations/tasks` 和 `/contents/generations/tasks/{id}`。

视频请求的 `content` 明确编码 `first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio`，成功状态读取 `content.video_url`。模型目录真实请求所填地址下的 `/models`；Agent Plan 返回 404 时提示手动填写模型名，不返回虚构模型列表。

## 本地自动验证

`internal/protocol/autodl_test.go`、`ark_video_test.go`、`internal/service/autodl_test.go`、`internal/httpapi/external_workflows_test.go` 覆盖规则转换、非法参数、分页/缓存过期、原始 Token 鉴权、视频/音频线路分发、方舟两个基础路径、素材角色、响应读取和元数据身份限制。网络行为使用 `httptest` 模拟上游。

界面通过前端构建和 Lint。真实视频/音频生成、API Key 权限、套餐额度及外部产物下载尚未以付费上游验证。
