/**
 * Video plugin for New API Task Plugin API v1.
 * CONFIG fixes the model capabilities, field paths, and states at generation time.
 * The host invokes creation, polling, billing, and downloads without external files or code generation.
 * API keys come only from channel ctx.apiKey and are never embedded or returned to clients.
 */
const contract = CONFIG.contract;
const options = CONFIG.options;
const profiles = contract.model_profiles;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function usageSchema(profile) {
  const schema = { seconds: { type: "number", unit: "second", description: { zh: "视频生成单价", en: "Video generation unit price" } } };
  if (profile.capability.resolutions.length) {
    schema.resolution = { enum: profile.capability.resolutions, description: { zh: "输出清晰度", en: "Output resolution" } };
  }
  return schema;
}

// Bind exact model IDs with separate parameter and pricing schemas.
export const meta = {
  apiVersion: 1,
  key: options.key,
  name: contract.name,
  version: options.version,
  author: { name: "Video contract generator" },
  description: { zh: "由视频契约生成的异步视频插件", en: "Contract-generated video task plugin" },
  ...(options.base_url ? { baseUrl: options.base_url } : {}),
  auth: options.auth_mode === "none" ? "none" : "api_key",
  models: options.models,
  fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: usageSchema(profiles[0]),
  usageProfiles: profiles.slice(1).map(profile => ({ models: [profile.model], schema: usageSchema(profile) })),
  ...(options.download_mode === "authenticated_url" && contract.artifact.allowed_hosts.length
    ? { allowedHosts: contract.artifact.allowed_hosts } : {}),
};

function profileFor(model) {
  const profile = profiles.find(item => item.model === model);
  if (!profile) throw new Error("模型不属于此插件: " + model);
  return profile;
}

// The host selects a declared upstream profile, or the client model's profile for vendor endpoint IDs.
function capabilityModel(ctx) {
  return profiles.some(profile => profile.model === ctx.upstreamModel) ? ctx.upstreamModel : ctx.model;
}

// Paths use validated field names and array indices without eval or prototype access.
function segments(path) {
  return path.replace(/\[([0-9]+)\]/g, (_match, index) => "." + Number(index)).split(".");
}

function read(value, path) {
  if (!path) return undefined;
  for (const part of segments(path)) {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch (_) { return undefined; }
    }
    if (!value || typeof value !== "object" || !own(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function write(target, path, value) {
  if (!path || value === undefined) return;
  const parts = segments(path);
  let current = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) current[part] = value;
    else {
      if (!own(current, part)) current[part] = /^[0-9]+$/.test(parts[index + 1]) ? [] : {};
      current = current[part];
    }
  });
}

function firstString(body, paths) {
  for (const path of paths) {
    const value = read(body, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function count(value) {
  if (value === undefined || value === null || value === false) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  return 1;
}

const materialFields = {
  first_frame: "first_frame_field", last_frame: "last_frame_field",
  reference_image: "reference_images_field", reference_video: "reference_videos_field", reference_audio: "reference_audios_field",
};
const materialRanges = { first_frame: "first_frame", last_frame: "last_frame", reference_image: "image", reference_video: "video", reference_audio: "audio" };

function ruleMatches(rule, values) {
  let value = values[rule.when.field];
  if (own(materialFields, rule.when.field)) value = count(value);
  return rule.when.operator === "present" ? count(value) > 0
    : String(value === undefined ? "" : value).trim().toLowerCase() === String(rule.when.value).trim().toLowerCase();
}

// Reject undeclared fields, including unknown nested properties.
function checkFields(body, paths) {
  const leaves = paths.filter(Boolean).map(path => segments(path).join("."));
  function visit(value, path) {
    if (leaves.includes(path)) return;
    if (path && !leaves.some(leaf => leaf.startsWith(path + "."))) throw new Error("契约未声明字段: " + path);
    if (!value || typeof value !== "object") throw new Error("嵌套字段必须是对象或数组: " + path);
    for (const key of Object.keys(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("请求包含保留字段");
      const next = path ? path + "." + key : key;
      // Allow null array holes only as placeholders before declared indices.
      if (Array.isArray(value) && value[key] === null && !leaves.some(leaf => leaf === next || leaf.startsWith(next + "."))) continue;
      visit(value[key], next);
    }
  }
  visit(body, "");
}

/**
 * Validate the selected model's actual request fields and material constraints.
 * Apply conditional rules once to the original input without mutating ctx.requestBody.
 * Decode, submit, and usage hooks share the original input to avoid applying rules twice.
 */
function parameterValue(parameter, value) {
  const fail = () => { throw new Error("参数 " + parameter.name + " 的值不符合契约"); };
  if (parameter.type === "boolean") { if (typeof value !== "boolean") fail(); }
  else if (["number", "integer"].includes(parameter.type)) {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER
      || parameter.type === "integer" && !Number.isInteger(value)
      || parameter.minimum != null && value < parameter.minimum || parameter.maximum != null && value > parameter.maximum) fail();
  } else {
    if (typeof value !== "string" || parameter.required && !value.trim()
      || parameter.max_length > 0 && [...value].length > parameter.max_length
      || parameter.enum?.length && !parameter.enum.includes(value)) fail();
    if (parameter.format === "uri" && !/^https?:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/.test(value)) fail();
  }
  return value;
}

function normalize(body, model, files = []) {
  if (!object(body)) throw new Error("请求必须是 JSON 对象");
  const profile = profileFor(model);
  const cap = profile.capability;
  const fields = contract.request;
  const promptRule = cap.prompt || { required: true, min_length: 0, max_length: 0 };
  if (body.prompt !== undefined || promptRule.required) {
    if (typeof body.prompt !== "string" || promptRule.required && !body.prompt.trim()) throw new Error("请输入视频提示词");
    if ([...body.prompt].length < promptRule.min_length || promptRule.max_length > 0 && [...body.prompt].length > promptRule.max_length) throw new Error("提示词长度不符合契约");
  }
  const explicitMode = read(body, fields.generation_mode_field);
  let mode;
  if (explicitMode !== undefined) {
    mode = profile.generation.modes.find(item => (item.request_value || item.id) === explicitMode);
  } else {
    const hasReference = [fields.reference_images_field, fields.reference_videos_field, fields.reference_audios_field]
      .some(path => count(read(body, path)) > 0);
    const hasFrame = [fields.first_frame_field, fields.last_frame_field]
      .some(path => typeof read(body, path) === "string" && count(read(body, path)) > 0);
    const kind = hasReference ? "reference" : hasFrame ? "image" : "text";
    mode = profile.generation.modes.find(item => item.kind === kind);
  }
  if (!mode) throw new Error("当前模型不支持所选生成模式或素材组合");
  const allowed = ["model", "prompt", fields.duration_field, fields.aspect_ratio_field, fields.resolution_field,
    fields.generate_audio_field, fields.watermark_field, fields.generation_mode_field];
  const parameters = (cap.parameters || []).filter(p => !p.modes?.length || p.modes.includes(mode.kind));
  const parameterValues = {};
  for (const parameter of parameters) {
    allowed.push(parameter.field);
    let value = read(body, parameter.field);
    if (value === undefined) value = parameter.default;
    if (value == null) {
      if (parameter.required || read(body, parameter.field) !== undefined) throw new Error("请填写参数 " + parameter.label);
    } else parameterValues[parameter.name] = parameterValue(parameter, value);
  }
  const values = {};
  const usedScalarPaths = new Set();
  for (const key of Object.keys(materialFields)) {
    const range = mode.materials[materialRanges[key]];
    const path = fields[materialFields[key]];
    const active = range.max > 0;
    const value = active && !(fields.reference_value_type === "scalar" && usedScalarPaths.has(path)) ? read(body, path) : undefined;
    if (value !== undefined && fields.reference_value_type === "scalar") usedScalarPaths.add(path);
    if (active) allowed.push(path);
    const multiple = key.startsWith("reference_") && fields.reference_value_type !== "scalar";
    if (value !== undefined && (multiple ? !Array.isArray(value) : typeof value !== "string")) {
      throw new Error(path + (multiple ? " 必须是 URL 数组" : " 必须是 URL 字符串"));
    }
    values[key] = value === undefined ? (multiple ? [] : "") : value;
    const amount = count(values[key]);
    if (amount < range.min || amount > range.max) throw new Error(mode.label + "的素材数量不符合契约: " + key);
    for (const url of multiple ? values[key] : amount ? [values[key]] : []) {
      if (files.some(file => file.ref === url)) continue;
      if (typeof url !== "string" || !/^https?:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/.test(url)) {
        throw new Error("素材必须使用不含凭据的公网 HTTP(S) URL");
      }
    }
  }
  checkFields(body, allowed);
  const total = Object.keys(materialFields).reduce((sum, key) => sum + count(values[key]), 0);
  if (total < mode.materials.total.min || total > mode.materials.total.max) throw new Error("素材合计数量不符合契约");
  const duration = read(body, fields.duration_field);
  if (duration !== undefined && (fields.duration_value_type === "string"
    ? typeof duration !== "string" || !/^[0-9]+$/.test(duration)
    : typeof duration !== "number" || !Number.isInteger(duration))) throw new Error("视频时长的类型不符合契约");
  values.duration = duration === undefined ? cap.default_seconds : Number(duration);
  const size = read(body, fields.aspect_ratio_field);
  const resolution = read(body, fields.resolution_field);
  values.size = size === undefined ? cap.default_size : size;
  values.resolution = resolution === undefined ? cap.default_resolution : resolution;
  for (const key of ["generate_audio", "watermark"]) {
    const value = read(body, fields[key + "_field"]);
    if (value !== undefined && typeof value !== "boolean") throw new Error(key + " 必须是布尔值");
    values[key] = value === undefined ? false : value;
  }
  values.generate_audio = cap.audio_control === "always" || cap.audio_control === "toggle" && values.generate_audio;
  values.watermark = cap.watermark && values.watermark;
  for (const rule of profile.rules) {
    if (!ruleMatches(rule, values)) continue;
    for (const key of Object.keys(rule.force_values || {})) {
      const value = rule.force_values[key];
      values[key] = key === "duration" ? Number(value)
        : ["generate_audio", "watermark"].includes(key) ? ["true", "1", "t"].includes(value.toLowerCase()) : value;
    }
  }
  if (cap.audio_control !== "toggle") values.generate_audio = cap.audio_control === "always";
  if (!cap.watermark) values.watermark = false;
  for (const rule of profile.rules) {
    if (!ruleMatches(rule, values)) continue;
    if ((rule.require || []).some(key => count(values[key]) === 0)
      || (rule.require_any || []).length && !rule.require_any.some(key => count(values[key]) > 0)
      || (rule.forbid || []).some(key => count(values[key]) > 0)
      || Object.keys(rule.limits || {}).some(key => count(values[key]) > rule.limits[key])) throw new Error(rule.message);
  }
  if (!Number.isSafeInteger(values.duration) || (cap.seconds_range ? values.duration < cap.seconds_range.min || cap.seconds_range.max != null && values.duration > cap.seconds_range.max || (values.duration - cap.seconds_range.min) % cap.seconds_range.step !== 0 : !cap.seconds.includes(values.duration))) throw new Error("当前模型不支持所选时长");
  if (values.duration > 3600) throw new Error("New API 的视频秒数用量上限为 3600 秒");
  if (typeof values.size !== "string" || cap.sizes.length && !cap.sizes.includes(values.size)) throw new Error("当前模型不支持所选画幅");
  if (typeof values.resolution !== "string" || cap.resolutions.length && !cap.resolutions.includes(values.resolution)) throw new Error("当前模型不支持所选清晰度");
  const result = { model, ...(body.prompt === undefined ? {} : { prompt: body.prompt }) };
  for (const parameter of parameters) write(result, parameter.field, parameterValues[parameter.name]);
  write(result, fields.duration_field, fields.duration_value_type === "string" ? String(values.duration) : values.duration);
  if (values.size) write(result, fields.aspect_ratio_field, values.size);
  if (values.resolution) write(result, fields.resolution_field, values.resolution);
  if (cap.audio_control !== "none") write(result, fields.generate_audio_field, values.generate_audio);
  if (cap.watermark) write(result, fields.watermark_field, values.watermark);
  write(result, fields.generation_mode_field, mode.request_value || mode.id);
  for (const key of Object.keys(materialFields)) {
    if (count(values[key]) > 0) write(result, fields[materialFields[key]], values[key]);
  }
  return { body: result, values, mode, action: mode.kind === "text" ? "text_to_video" : "image_to_video" };
}

// Keys authenticate configured upstream API requests, never signed video downloads.
function authHeaders(ctx) {
  if (options.auth_mode === "none") return {};
  if (typeof ctx.apiKey !== "string" || !ctx.apiKey.trim()) throw new Error("请在 New API 渠道中配置上游密钥");
  return options.auth_mode === "bearer" ? { Authorization: "Bearer " + ctx.apiKey } : { [options.auth_header]: ctx.apiKey };
}

function endpoint(ctx, path, taskId) {
  if (typeof ctx.baseUrl !== "string" || !ctx.baseUrl.trim()) throw new Error("请在 New API 渠道中配置上游地址");
  if (path.includes("{task_id}")) {
    if (typeof taskId !== "string" || !taskId.trim() || [".", ".."].includes(taskId)) throw new Error("缺少有效的上游任务 ID");
    path = path.replace("{task_id}", encodeURIComponent(taskId));
  }
  return ctx.baseUrl.replace(/\/+$/, "") + path;
}

function remove(target, path) {
  const parts = segments(path);
  function descend(parent, index) {
    const key = parts[index];
    if (!parent || !own(parent,key)) return;
    if (index === parts.length-1) delete parent[key];
    else {
      descend(parent[key],index+1);
      if (parent[key] && typeof parent[key] === "object" && Object.keys(parent[key]).length === 0) delete parent[key];
    }
    if (Array.isArray(parent)) while (parent.length && !own(parent,String(parent.length-1))) parent.pop();
  }
  descend(target,0);
}

function fileField(role) {
  const name = contract.transport.multipart_fields?.[role] || contract.transport.multipart_file_field;
  if (!name) throw new Error("素材缺少文件字段: " + role);
  return name;
}

export function buildSubmitRequest(ctx) {
  const files = ctx.files || [];
  if (files.length && contract.transport.local_material !== "multipart") throw new Error("此契约不接受文件上传");
  const request = normalize(ctx.requestBody, capabilityModel(ctx), files);
  request.body.model = ctx.upstreamModel;
  const headers = authHeaders(ctx);
  const base = { url: endpoint(ctx, contract.transport.create_path), method: "POST" };
  if (!files.length) return { ...base, headers: { ...headers, "Content-Type": "application/json" }, body: request.body };
  const parts = [];
  const used = new Set();
  const fieldCounts = {};
  let hasURL = false;
  for (const role of Object.keys(materialFields)) {
    if (request.mode.materials[materialRanges[role]].max === 0) continue;
    const path = contract.request[materialFields[role]];
    const value = read(request.body, path);
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const urls = [];
    for (const value of values) {
      const file = files.find(file => file.ref === value);
      if (!file) { urls.push(value); hasURL = true; continue; }
      if (used.has(file.ref)) continue;
      used.add(file.ref);
      const name = fileField(role);
      fieldCounts[name] = (fieldCounts[name] || 0) + 1;
      if (fieldCounts[name] > 1 && !contract.transport.multipart_repeatable) throw new Error("契约不允许同字段重复上传文件");
      parts.push({name, fileRef:file.ref, filename:file.filename});
    }
    if (values.length) {
      if (!urls.length) remove(request.body,path);
      else write(request.body,path,Array.isArray(value) ? urls : urls[0]);
    }
  }
  if (used.size !== files.length) throw new Error("存在未映射的上传文件");
  if (hasURL && !contract.transport.multipart_mixed_urls) throw new Error("契约不允许文件与 URL 混传");
  for (const [name,value] of Object.entries(request.body)) {
    if (value !== undefined) parts.push({name,value:typeof value === "object" ? JSON.stringify(value) : String(value)});
  }
  return {...base,headers,bodyType:"multipart",parts};
}

// Decode host-parsed multipart values without reading or re-encoding file bytes.
function decodeMultipart(ctx) {
  if (contract.transport.local_material !== "multipart") throw new Error("此契约不接受 multipart");
  const body = {};
  const profile = profileFor(capabilityModel(ctx));
  const fields = contract.request;
  const scalarTypes = {model:"string",prompt:"string"};
  scalarTypes[fields.duration_field] = fields.duration_value_type;
  scalarTypes[fields.generate_audio_field] = "boolean";
  scalarTypes[fields.watermark_field] = "boolean";
  for (const parameter of profile.capability.parameters || []) scalarTypes[parameter.field] = parameter.type;
  for (const [name,values] of Object.entries(ctx.body.fields || {})) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*|\[[0-9]+\])*$/.test(name) || !values.length || segments(name).some(part => ["__proto__","prototype","constructor"].includes(part))) throw new Error("无效表单字段");
    const reference = [fields.reference_images_field,fields.reference_videos_field,fields.reference_audios_field].includes(name) && fields.reference_value_type !== "scalar";
    if (!reference && values.length !== 1) throw new Error("标量字段不能重复: " + name);
    let value = reference ? values : values[0];
    if (reference && values.length === 1 && values[0].trim().startsWith("[")) value = JSON.parse(values[0]);
    else if (scalarTypes[name] === "number" || scalarTypes[name] === "integer") {
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) throw new Error("无效数字表单字段: " + name);
      value = Number(value);
    } else if (scalarTypes[name] === "boolean") {
      if (value !== "true" && value !== "false") throw new Error("无效布尔表单字段: " + name);
      value = value === "true";
    } else if (!own(scalarTypes,name) && (String(value).startsWith("{") || String(value).startsWith("["))) value = JSON.parse(value);
    write(body,name,value);
  }
  const explicit = read(body, fields.generation_mode_field);
  for (const file of ctx.body.files || []) {
    let candidates = Object.keys(materialFields).filter(role => {
      const modes = profile.generation.modes.filter(mode => explicit === undefined || (mode.request_value || mode.id) === explicit);
      return modes.some(mode => mode.materials[materialRanges[role]].max > 0) && fileField(role) === file.field;
    });
    if (candidates.length > 1 && fields.reference_value_type === "scalar" && candidates.every(role => role.startsWith("reference_"))) {
      const category = String(file.mimeType || "").split("/")[0];
      candidates = candidates.filter(role => role === "reference_" + category);
    }
    if (candidates.length !== 1) throw new Error("上传字段无法唯一映射素材类型: " + file.field);
    const role = candidates[0];
    const path = fields[materialFields[role]];
    const current = read(body,path);
    const multiple = role.startsWith("reference_") && fields.reference_value_type !== "scalar";
    if (!multiple && current !== undefined) throw new Error("单值素材不能重复提交");
    write(body,path,multiple ? [...(current || []),file.ref] : file.ref);
  }
  return body;
}

export function parseSubmitResponse(_ctx, response) {
  const body = response.body;
  if (!object(body)) throw new Error("上游创建响应必须是 JSON 对象");
  const taskId = firstString(body, contract.polling.task_id_fields);
  if (!taskId || [".", ".."].includes(taskId)) throw new Error("上游创建响应缺少有效任务 ID");
  const result = { taskId, taskData: body };
  // Creation may return only a task ID; any returned status must match the contract.
  if (contract.polling.status_fields.some(path => read(body, path) !== undefined)) {
    const parsed = parseTaskResult({ taskId }, body);
    if (parsed.status === "UNKNOWN") throw new Error(parsed.reason);
    if (["SUCCESS", "FAILURE"].includes(parsed.status)) result.immediate = parsed;
  }
  return result;
}

export function buildQueryRequest(ctx) {
  return { url: endpoint(ctx, contract.transport.query_path, ctx.taskId), method: "GET", headers: authHeaders(ctx) };
}

export function parseTaskResult(ctx, body) {
  if (!object(body)) return { status: "UNKNOWN", reason: "上游任务响应必须是 JSON 对象" };
  const id = firstString(body, contract.polling.task_id_fields);
  if (id && id !== ctx.taskId) return { status: "UNKNOWN", reason: "上游响应任务 ID 不匹配" };
  const status = firstString(body, contract.polling.status_fields).toLowerCase();
  const groups = [["queued_statuses", "QUEUED"], ["processing_statuses", "IN_PROGRESS"], ["success_statuses", "SUCCESS"], ["failure_statuses", "FAILURE"]];
  const matched = groups.find(([key]) => contract.polling[key].includes(status));
  if (!matched) return { status: "UNKNOWN", reason: "上游状态未在契约中声明" };
  const result = { status: matched[1] };
  for (const path of contract.polling.progress_fields) {
    const value = read(body, path);
    if (typeof value !== "number" && typeof value !== "string" || String(value).trim() === "") continue;
    const progress = Number(String(value).trim().replace(/%$/, ""));
    if (Number.isFinite(progress) && progress >= 0 && progress <= 100) { result.progress = Math.round(progress) + "%"; break; }
  }
  if (result.status === "SUCCESS") result.progress = "100%";
  if (result.status === "FAILURE") result.reason = firstString(body, contract.polling.error_fields) || "上游视频任务失败";
  return result;
}

// Report request facts; New API settings define prices and billing rules.
export function extractUsage(ctx) {
  const model = capabilityModel(ctx);
  const values = normalize(ctx.requestBody, model, ctx.files || []).values;
  if (ctx.usagePurpose === "billing_ratios") return {};
  const usage = { seconds: values.duration };
  if (profileFor(model).capability.resolutions.length) usage.resolution = values.resolution;
  return usage;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

function resultURL(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) { const found = resultURL(item); if (found) return found; }
  }
  return "";
}

/**
 * Download policy is selected at generation time without endpoint probing or stale URLs.
 * signed_url: authenticate task lookup, then download without credentials.
 * task_content: request the declared artifact path; the host rejects credentialed cross-origin redirects.
 * authenticated_url: refresh the result URL, then send the channel key only to host-approved domains.
 */
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const method = ctx.clientRequest.method;
  if (!["GET", "HEAD"].includes(method)) throw new Error("视频下载仅支持 GET/HEAD");
  if (options.download_mode === "task_content") {
    const url = endpoint(ctx, contract.artifact.content_path, ctx.upstreamTaskId);
    return options.auth_mode === "none" ? { url, method, credentialless: true } : { url, method, headers: authHeaders(ctx) };
  }
  const response = utils.fetch({ url: endpoint(ctx, contract.transport.query_path, ctx.upstreamTaskId), method: "GET", headers: authHeaders(ctx) });
  if (response.status !== 200) throw new Error("视频结果查询失败，状态码 " + response.status);
  if (parseTaskResult({ taskId: ctx.upstreamTaskId }, response.body).status !== "SUCCESS") throw new Error("视频尚未完成或任务状态不匹配");
  let url = "";
  for (const path of options.result_fields) { url = resultURL(read(response.body, path)); if (url) break; }
  if (url.startsWith("/") && !url.startsWith("//")) url = endpoint(ctx, url);
  if (!/^https?:\/\/[^/?#@\s]+(?:[/?][^#\s]*)?$/.test(url)) throw new Error("查询结果中没有有效的 HTTP(S) 视频地址");
  if (options.download_mode === "signed_url" || options.auth_mode === "none") return { url, method, credentialless: true };
  return { url, method, headers: authHeaders(ctx) };
}

// Expose only the OpenAI video protocol, without native routes or editing/remix support.
export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (!ctx.body || !["json","multipart"].includes(ctx.body.kind)) throw new Error("此插件只接受 JSON 或已声明的 multipart 请求");
      const body = ctx.body.kind === "multipart" ? decodeMultipart(ctx) : ctx.body.value;
      const normalized = normalize(body, capabilityModel(ctx), ctx.body.files || []);
      return { kind: "submit", model: ctx.model, action: normalized.action, requestBody: body };
    },
    render(_ctx, task) {
      // The host supplies public IDs, states, and timestamps; private IDs, keys, and signed URLs stay internal.
      return task.status === "FAILURE" ? { error: { code: "video_generation_failed", message: task.fail_reason || "视频生成失败" } } : {};
    },
  },
};
