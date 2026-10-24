/**
 * Dramaya Grok 视频插件，使用 New API Task Plugin API v1。
 *
 * 将本文件上传到 New API 任务插件管理，并把 Dramaya 渠道绑定到 meta.key。
 * New API 宿主负责提供各个钩子函数的上下文，以及同步调用的 utils.fetch 工具。
 * 本文件运行于插件环境，不是独立的 Node 程序，也不是创作台使用的 JSON 视频契约。
 *
 * 完整调用流程：
 *   创建：客户端 JSON -> decodeRequest -> buildSubmitRequest -> parseSubmitResponse。
 *   轮询：未完成任务 -> buildQueryRequest -> parseTaskResult -> 完成或失败。
 *   下载：已完成任务 -> listArtifacts -> buildContentRequest -> 宿主代理视频文件。
 *   查询：render 补充协议字段，宿主统一生成客户端可见的任务响应。
 *
 * 三种鉴权信息的用途不同：
 *   - 客户端的 New API 令牌：用于访问自己的 New API 网关。
 *   - ctx.apiKey：渠道中配置的 Dramaya Key，仅用于访问上游 API。
 *   - 视频签名 URL：通过地址自身的临时签名授权下载，不携带上述两种 API 令牌。
 * 同样要区分 New API 对外的公共任务 ID，以及 Dramaya 返回的私有上游任务 ID。
 *
 * 下方模型能力来自用户在 2026-10-20 提供的当前 Key 公开参数，属于明确配置。
 * 插件不会在运行时自动读取或扩展模型能力；上游能力变更后，需要重新核对配置。
 * 当前实现视频生成，不包含视频编辑、取消提交、multipart 文件上传或参数别名转换。
 */

// 同一个插件支持两个模型，但分别校验清晰度和参考图数量。
// images 为 0 表示只能省略图片列表或传空数组，不代表支持参考图生成。
const MODELS = {
  "grok-imagine-video": { resolutions: ["480p", "720p"], images: 0 },
  "grok-imagine-video-1.5": { resolutions: ["480p", "720p", "1080p"], images: 1 },
};
const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];

// 用量 schema 声明 New API 定价页面可使用的字段及取值范围。
// 此处不填写供应商价格、汇率或加价倍率；实际售价由管理员在后台配置。
const SECONDS_USAGE = {
  type: "number",
  unit: "second",
  description: { en: "Video generation unit price", zh: "视频生成单价" },
};
const STANDARD_USAGE = {
  seconds: SECONDS_USAGE,
  resolution: {
    enum: MODELS["grok-imagine-video"].resolutions,
    description: { en: "Output video resolution", zh: "输出视频分辨率" },
  },
};
const V15_USAGE = {
  seconds: SECONDS_USAGE,
  resolution: {
    enum: MODELS["grok-imagine-video-1.5"].resolutions,
    description: { en: "Output video resolution", zh: "输出视频分辨率" },
  },
};

/**
 * New API 加载插件时读取的注册信息。
 *
 * key：渠道绑定的稳定标识；version：插件的功能版本。
 * baseUrl：默认上游地址，不带 /v1；实际请求使用渠道生效后的 ctx.baseUrl。
 * models：支持的完整模型 ID，不能使用未声明的简称。
 * fetchMode=per_task：逐个任务查询状态，不使用批量轮询。
 * protocols=openai_video：接入宿主提供的 /v1/videos 协议。
 * 不声明 channelTypes，避免占用其他供应商的渠道类型。
 * usageSchema：普通模型使用的定价字段；usageProfiles：1.5 模型的独立字段。
 * 将 1080p 限定在 1.5 的 schema 中，避免普通模型错误获得该选项。
 */
export const meta = {
  apiVersion: 1,
  key: "dramaya-grok",
  name: "Dramaya Grok 视频",
  version: "1.0.1",
  author: { name: "chatgpt2api contributors" },
  description: {
    en: "Dramaya Grok video generation with model-specific resolution and reference image limits",
    zh: "Dramaya Grok 视频生成，分别校验各模型的清晰度和参考图限制",
  },
  baseUrl: "https://video.dramaya.us",
  models: Object.keys(MODELS),
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: STANDARD_USAGE,
  usageProfiles: [{ models: ["grok-imagine-video-1.5"], schema: V15_USAGE }],
};

/**
 * 校验请求，并构造符合 Dramaya 契约的 JSON 请求体。
 *
 * @param {Object} req 已解析的 JSON 对象，可以来自协议解码前或解码后的请求。
 * @param {string} model 当前阶段选定的模型：解码时为 ctx.model；渠道选定后，
 *   提交和用量计算使用 ctx.upstreamModel，即实际发送给上游的模型。
 * @returns {Object} 新建的上游请求体，不直接修改传入对象。
 * @throws {Error} 字段类型不正确、包含未知字段，或超出模型能力范围时抛出错误。
 *
 * 提交前再次校验，可防止渠道模型映射后，仍然沿用原模型才支持的参数。
 * 以调用方传入的 model 参数为准，req.model 不会覆盖该模型选择。
 */
function normalizeRequest(req, model) {
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("JSON object required");
  if (!Object.prototype.hasOwnProperty.call(MODELS, model)) throw new Error("Unsupported Dramaya Grok model");
  // 未声明字段直接报错，避免用户传入的设置被静默丢弃。
  // 此处不把 seconds、size 当成 duration、aspect_ratio 的别名。
  for (const key of Object.keys(req)) {
    if (!["model", "prompt", "duration", "aspect_ratio", "resolution", "image_urls"].includes(key)) {
      throw new Error("Unsupported field: " + key + "; use duration, aspect_ratio, resolution and image_urls");
    }
  }
  // trim() 只用于判断提示词是否为空，发送时保留用户原始文本。
  if (typeof req.prompt !== "string" || !req.prompt.trim()) throw new Error("prompt must be a non-empty string");
  // 只有未传入字段时才采用默认值；显式 null、数字字符串、小数时长和越界值均报错。
  const duration = req.duration === undefined ? 8 : req.duration;
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error("duration must be an integer between 1 and 15");
  // aspect_ratio 决定画面宽高比例，resolution 决定输出清晰度。
  // 两者独立，例如可以同时选择 16:9 和 720p。
  const aspectRatio = req.aspect_ratio === undefined ? "16:9" : req.aspect_ratio;
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error("Unsupported aspect_ratio");
  const resolution = req.resolution === undefined ? "480p" : req.resolution;
  if (!MODELS[model].resolutions.includes(resolution)) throw new Error("Unsupported resolution for " + model);
  const images = req.image_urls === undefined ? [] : req.image_urls;
  if (!Array.isArray(images) || images.length > MODELS[model].images) {
    throw new Error(model + " accepts at most " + MODELS[model].images + " reference image(s)");
  }
  // 此处只检查 URL 格式：HTTPS、不含用户名密码、不含空白字符。
  // 正则不会解析 DNS，也不能证明地址可被公网访问；图片由 Dramaya 实际读取。
  // 文档声明的 PNG/JPEG/WebP 类型与 20 MiB 大小限制，由 Dramaya 校验。
  for (const url of images) {
    if (typeof url !== "string" || !/^https:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/.test(url)) {
      throw new Error("image_urls must contain public HTTPS URLs without credentials");
    }
  }
  // 空列表不写入请求体；非空列表复制一份，避免与调用方共用数组。
  // 后续根据 image_urls 是否存在，区分图生视频和文生视频。
  const body = { model, prompt: req.prompt, duration, aspect_ratio: aspectRatio, resolution };
  if (images.length) body.image_urls = images.slice();
  return body;
}

/**
 * 使用私有上游任务 ID 构建 Dramaya 的任务查询地址。
 * 拒绝空 ID、单点和双点路径；将整个 ID 编码成一个路径段，
 * 防止 ID 中的斜杠、问号等字符改变请求路径或查询参数。
 */
function taskPath(baseUrl, taskId) {
  if (typeof taskId !== "string" || !taskId.trim() || taskId === "." || taskId === "..") {
    throw new Error("A valid upstream task id is required");
  }
  return baseUrl.replace(/\/+$/, "") + "/v1/videos/" + encodeURIComponent(taskId);
}

/**
 * 构造带鉴权的视频生成请求描述，由 New API 宿主负责发送。
 * ctx.baseUrl 和 ctx.apiKey 来自选定渠道，不由客户端请求体指定。
 * ctx.publicTaskId 是网关公共任务 ID，在这里用于生成幂等键。
 * 即使绕过 JSON 协议解码器，进入此函数时仍会拒绝上传文件。
 */
export function buildSubmitRequest(ctx) {
  if ((ctx.files || []).length) throw new Error("File uploads are not supported; use image_urls");
  const body = normalizeRequest(ctx.requestBody, ctx.upstreamModel);
  if (typeof ctx.publicTaskId !== "string" || !ctx.publicTaskId.trim()) throw new Error("New API public task id is required");
  return {
    url: ctx.baseUrl.replace(/\/+$/, "") + "/v1/videos",
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.apiKey,
      "Content-Type": "application/json",
      // 同一个网关任务内部重试时复用此键，不同任务使用不同键。
      // 客户端重新 POST 会产生新的公共任务 ID，因此也会产生新的幂等键；
      // 不能依靠此机制对多次独立提交去重，已有任务应继续查询而非重复生成。
      "Idempotency-Key": "newapi-" + ctx.publicTaskId,
    },
    body,
  };
}

/**
 * 提取上游任务 ID，并把上游响应保留为内部任务数据。
 * response.body 是已解析的上游响应；仅有非空 ID 还不够，状态也必须可识别。
 * 返回的 taskId 属于上游私有 ID，不能用它替换客户端看到的网关公共 ID。
 */
export function parseSubmitResponse(ctx, response) {
  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id !== "string" || !body.id.trim()) {
    throw new Error("Dramaya create response is missing id");
  }
  const status = parseTaskResult({ taskId: body.id }, body);
  if (status.status === "UNKNOWN") throw new Error("Dramaya create response has an unrecognized status");
  const result = { taskId: body.id, taskData: body };
  // 幂等重试可能直接返回已完成或已失败的旧结果。
  // 此时通过 immediate 立即告知宿主终态，避免重新当作排队任务处理。
  if (status.status === "SUCCESS" || status.status === "FAILURE") result.immediate = status;
  return result;
}

/**
 * 为 New API 的定价规则提供经过校验的请求用量字段。
 * seconds 是本插件 schema 中的计费字段名，不是上游请求参数别名：
 * 真正发给 Dramaya 的生成请求仍使用 duration。
 * 公开响应未明确给出这两个模型的权威实际计费时长，
 * 因此不导出完成用量钩子，也不从文件大小或进度猜测实际费用。
 */
export function extractUsage(ctx) {
  const body = normalizeRequest(ctx.requestBody, ctx.upstreamModel);
  // billing_ratios 返回空对象，避免给按次定价额外乘上时长倍率。
  // 其他用途返回请求时长和清晰度，供已配置的计费表达式使用；不推测上游价格。
  if (ctx.usagePurpose === "billing_ratios") return {};
  return { seconds: body.duration, resolution: body.resolution };
}

/**
 * 查询单个上游任务；这里的 ctx.taskId 是提交响应中保存的私有上游 ID。
 * 轮询只读取状态，不创建新的生成任务，也不生成新的幂等键。
 */
export function buildQueryRequest(ctx) {
  return {
    url: taskPath(ctx.baseUrl, ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey },
  };
}

/**
 * 将 Dramaya 的任务响应转换为 New API 的标准任务状态。
 * 如果上游响应包含 id，它必须与本次查询的任务 ID 一致。
 * UNKNOWN 表示响应无法可靠解释，由宿主决定后续重试或失败策略；
 * 不把未知状态猜测成运行中、成功或上游生成失败。
 */
export function parseTaskResult(ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "Dramaya task response must be an object" };
  if (body.id !== undefined && body.id !== ctx.taskId) return { status: "UNKNOWN", reason: "Dramaya returned a different task id" };
  // cancel_requested 只表示已请求取消，任务仍未终止。
  // failed、cancelled、expired 均作为终止失败映射为 FAILURE。
  const statuses = {
    queued: "QUEUED",
    pending: "QUEUED",
    running: "IN_PROGRESS",
    in_progress: "IN_PROGRESS",
    processing: "IN_PROGRESS",
    cancel_requested: "IN_PROGRESS",
    completed: "SUCCESS",
    failed: "FAILURE",
    cancelled: "FAILURE",
    expired: "FAILURE",
  };
  if (typeof body.status !== "string" || !Object.prototype.hasOwnProperty.call(statuses, body.status)) {
    return { status: "UNKNOWN", reason: "Unrecognized Dramaya task status" };
  }
  // 以 status 为准：即使运行中任务的 progress=100，也不能判定生成成功。
  // 宿主需要百分比字符串，例如 "17%"，而不是小数比例。
  const result = { status: statuses[body.status] };
  if (typeof body.progress === "number" && Number.isFinite(body.progress) && body.progress >= 0 && body.progress <= 100) {
    result.progress = body.progress + "%";
  }
  if (result.status === "SUCCESS") result.progress = "100%";
  // 支持字符串 error 或 error.message；只提取错误说明，
  // 避免把完整上游私有响应序列化进客户端错误信息。
  if (result.status === "FAILURE") {
    const error = typeof body.error === "string" ? body.error : body.error && body.error.message;
    result.reason = typeof error === "string" && error.trim() ? error : "Dramaya video task " + body.status;
  }
  return result;
}

/**
 * 仅在生成成功后声明可下载的视频产物。
 * 这里只声明产物类型，不携带签名 URL，也不表示文件已下载或保存。
 * 宿主对外提供带鉴权的 content 路由；实际下载时，
 * 再由 buildContentRequest 获取当时有效的上游下载地址。
 */
export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

/**
 * 获取新的签名视频地址，并构造不携带 API 凭据的 CDN 下载请求。
 *
 * @param {Object} ctx 宿主传入的下载上下文，包含渠道 baseUrl/apiKey、
 *   私有 upstreamTaskId、产物 artifactKey 和客户端的 clientRequest.method。
 * @returns {Object} GET/HEAD 请求描述，设置 credentialless: true，不包含 headers。
 *
 * v1.0.1 修复的关键问题：旧版携带 Key 请求上游 /content，可能遇到跨域跳转。
 * New API 为避免凭据泄露会拒绝这种跳转，导致视频已生成，但下载保存失败。
 * 现在先带 Key 查询任务，再使用返回的签名地址下载，下载时不发送 Dramaya Key。
 */
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  if (!["GET", "HEAD"].includes(ctx.clientRequest.method)) throw new Error("Video content supports GET and HEAD only");
  // 第一步：带 Dramaya Key 查询上游任务，刷新结果地址。
  // utils.fetch 由 New API 注入，在这里返回已解析的响应。
  // 即使客户端发送 HEAD，这个内部查询仍需使用 GET 才能取得视频地址。
  // 不复用 ctx.data.video_url，因为任务保存时的签名可能已经过期。
  const response = utils.fetch({
    url: taskPath(ctx.baseUrl, ctx.upstreamTaskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey },
  });
  // 查询遇到重定向、鉴权失败或其他非 200 响应时立即报错，不使用旧地址兜底。
  // parseTaskResult 同时检查状态，以及响应中存在的任务 ID 是否匹配。
  if (response.status !== 200) throw new Error("Dramaya task lookup failed with status " + response.status);
  const body = response.body;
  const result = parseTaskResult({ taskId: ctx.upstreamTaskId }, body);
  if (result.status !== "SUCCESS") throw new Error("Dramaya video is not available for download");
  // 第二步：读取上游文档声明的结果结构，优先使用 video_url。
  // 也支持文档中的 data[].url；数组条目若明确标为非 MP4 类型，则不选取。
  let url = body.video_url;
  if ((typeof url !== "string" || !url.trim()) && Array.isArray(body.data)) {
    const video = body.data.find(function (item) {
      return item && typeof item.url === "string" && (!item.mime_type || item.mime_type === "video/mp4");
    });
    if (video) url = video.url;
  }
  // 第三步：只接受 HTTPS，拒绝内嵌用户名密码、空白字符和 # 片段。
  // 原样保留查询字符串，修改签名参数会破坏下载授权。
  // 此处只做格式校验，网络地址访问限制由宿主负责。
  if (typeof url !== "string" || !/^https:\/\/[^/?#@\s]+(?:[/?][^#\s]*)?$/.test(url)) {
    throw new Error("Dramaya completed task is missing a valid HTTPS video URL");
  }
  // 第四步：只返回签名 URL、请求方法和 credentialless 标记。
  // 不附加渠道 Key、客户端令牌、Cookie 或请求体。
  // 视频流、Range/Content-Range 和允许的无凭据重定向均由宿主处理；
  // 插件不会把整个 MP4 读入 JavaScript 内存。
  return {
    url,
    method: ctx.clientRequest.method,
    credentialless: true,
  };
}

/**
 * 客户端协议适配器，接入 New API 提供的 OpenAI 视频路由。
 * 请求字段仍按上面的 Dramaya 契约校验；声明 openai_video
 * 不等于实现了 OpenAI 视频协议的全部功能或所有接口。
 */
export const protocols = {
  openai_video: {
    /**
     * 在提交到渠道之前解析客户端 JSON，ctx.model 由宿主确定。
     * 标准化后的请求体会成为驱动函数收到的 ctx.requestBody。
     * action 用来标识文生视频或图生视频，两者都使用同一个上游 POST 接口。
     */
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("Dramaya requires a JSON body; use image_urls for reference images");
      const requestBody = normalizeRequest(ctx.body.value, ctx.model);
      return {
        kind: "submit",
        model: ctx.model,
        action: requestBody.image_urls ? "image_to_video" : "text_to_video",
        requestBody,
      };
    },
    /**
     * 为客户端查询任务的响应补充协议字段。
     * 成功时返回空对象是有意设计：New API 会补齐公共任务响应，
     * 客户端通过带鉴权的 content 路由读取视频，此函数不返回临时 CDN 地址。
     */
    render: function (_ctx, task) {
      // 公共 ID、状态和时间戳由宿主统一提供。
      // 不在响应中暴露私有上游 ID、鉴权凭据和会过期的视频签名地址。
      const result = {};
      if (task.status === "FAILURE") {
        result.error = { code: "video_generation_failed", message: task.fail_reason || "Dramaya video generation failed" };
      }
      return result;
    },
  },
};
