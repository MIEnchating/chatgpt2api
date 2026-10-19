# 渠道自定义参数转换

管理员可在「设置 → API 访问地址」下编辑默认中转规则。自定义 API 渠道不再提供独立参数转换规则，也不会套用管理员默认规则。配置通过服务端校验后保存。

转换规则处理创作任务的请求和响应。模型仍须在全局模型配置中开放，图片面板参数由图片模型定义管理，视频能力、时长和参考素材约束仍由视频模型契约管理。转换配置不会自动开放模型或放宽面板限制。

## 示例

```javascript
{
  models: {
    "actual-video-model": {
      POST: {
        url: "/jobs",
        body: {
          model,
          description: prompt,
          duration: seconds,
          references: images,
          first_frame: firstFrame,
          last_frame: lastFrame
        }
      },
      result: response => response.output.urls,
      error: response => response.error?.message,
      poll: {
        GET: { url: "/jobs/{taskId}" },
        taskId: "id",
        status: "state",
        success: ["completed"],
        failure: ["failed", "cancelled"],
        progress: "progress"
      }
    }
  }
}
```

`models` 的键必须是实际模型名称。空配置或空模型对象使用原有接口；命中转换规则后执行失败会直接报错，不切换协议重发。只计算当前模型的表达式，不计算其他模型的参数。

## 请求和结果

- 外层可配置 `headers` 和共用 `poll`；每个模型配置一种请求方法以及 `result`、`error`、`poll`。
- 请求支持 `url`、`headers`、`params`、`body`、`format` 和 `responseType`。
- `format`：`json`（默认）、`formData`、`urlencoded`、`raw`。表单素材地址按普通字段发送，不自动下载为文件。
- `responseType`：`json`（默认）、`text`、`blob`、`arraybuffer`。二进制接口返回错误 JSON 时不会作为媒体保存。
- 相对 `url` 追加到渠道 Base URL 的既有路径后，不添加或删除 `/v1`。绝对 URL 使用原样地址。
- 默认使用渠道 Key 的 Bearer 鉴权。请求中可以用 `{channelKey}` 设置其他鉴权格式；查询地址、请求头、参数和请求体支持 `{taskId}`。
- `result`、`error`、任务 ID、状态和进度提取支持点分路径（如 `data.0.url`）或同步函数。异步函数不受支持。
- `taskId` 可返回单个 ID 或 ID 数组。所有任务完成后合并结果；网络错误、HTTP 429 或 5xx 只重试查询，直到创作任务取消或超时，不重复提交。
- 同站 `/videos/{id}/content` 下载沿用请求头和查询参数。跨来源重定向会被拒绝。
- 视频结果中的 MP4、WebM、QuickTime Base64 Data URL 会先保存为本地视频文件，任务结果只持久化 `/videos/` 地址，避免大段 Base64 写入任务记录；无效数据会报错并清理临时文件。

可用变量：`model`、`prompt`、`size`、`aspectRatio`、`quality`、`count`、`images`、`resolution`、`seconds`、`mode`、`negativePrompt`、`generateAudio`、`watermark`、`videos`、`audios`、`firstFrame`、`lastFrame`、`voice`、`audioFormat`、`speed`、`instructions`。素材变量为 URL/Data URL 数组，未提供的可选标量为 `undefined`。

`aspectRatio` 按 `aspect_ratio`、`ratio`、`size` 的顺序取首个非空值，并转换为最简整数比例：`1536x1024` → `3:2`、`1920×1080` → `16:9`；`auto` 或无效尺寸得到空字符串。`size` 仍保留原始值。

## 任务生命周期

创作任务提交时固定所选渠道的地址和 Key；使用默认渠道时同时固定管理员规则。在排队或轮询过程中修改、清空或删除渠道不改变已提交请求；新任务和重试使用新配置。页面刷新通过现有创作任务查询恢复进度，不在浏览器重复发起生成。

固定配置仅由服务端任务持有，不出现在公共模型列表、任务响应或请求日志中。沿用现有服务端任务取消、超时和重启中断机制，不提供服务重启后续查上游任务的新增能力。本站没有上游项目的独立积分扣费系统；渠道实际计费由中转服务处理，因此不移植上游的本地积分退款逻辑。

规则在隔离的 JavaScript 运行时执行，不暴露文件、网络或进程 API；单次表达式执行限制为 1 秒，配置大小不超过 128 KiB，单次响应不超过 128 MiB。HTTP 请求通过现有中转客户端执行，复用现有媒体存储和调用结果日志。
