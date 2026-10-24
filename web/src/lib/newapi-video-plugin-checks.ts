import type { NewAPIVideoPluginResult } from "./api";
import type { VideoModelContract } from "./video-model-contracts";

export type GeneratedVideoPlugin = {
  meta: { apiVersion: number; key: string; version: string; baseUrl?: string; auth: string; models: string[]; protocols: string[]; routes?: unknown };
  buildSubmitRequest: (context: Record<string, unknown>) => { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown>; bodyType?: string; parts?: Array<{name:string;value?:unknown;fileRef?:string}> };
  parseSubmitResponse: (context: Record<string, unknown>, response: { body: Record<string, unknown> }) => { taskId: string };
  buildQueryRequest: (context: Record<string, unknown>) => { url: string; method: string; headers: Record<string, string> };
  parseTaskResult: (context: Record<string, unknown>, body: Record<string, unknown>) => { status: string };
  extractUsage: (context: Record<string, unknown>) => Record<string, unknown>;
  listArtifacts: (task: { status: string }) => Array<{ key: string }>;
  buildContentRequest: (context: Record<string, unknown>) => { url: string; method: string; credentialless?: boolean; headers?: Record<string, string> };
  protocols: {
    openai_video: {
      decodeRequest: (context: { model: string; upstreamModel?: string; body: { kind: string; value?: Record<string, unknown>; fields?: Record<string,string[]>; files?: Array<{ref:string;field:string;filename:string;mimeType:string;size:number}> } }) => { kind: string; model: string; action: string; requestBody?: Record<string,unknown> };
      render: (context: Record<string, unknown>, task: Record<string, unknown>) => Record<string, unknown>;
    };
  };
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  if (!path) return;
  const parts = path.replace(/\[([0-9]+)\]/g, ".$1").split(".");
  let current: Record<string, unknown> = target;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index === parts.length - 1) {
      current[part] = value;
      return;
    }
    const nextIsArray = /^\d+$/.test(parts[index + 1]);
    let next = current[part];
    if (!next || typeof next !== "object") {
      next = nextIsArray ? [] : {};
      current[part] = next;
    }
    current = next as Record<string, unknown>;
  }
}

function responseBody(contract: VideoModelContract, status: string, taskID: string, resultFields: string[], resultURL: string) {
  const body: Record<string, unknown> = {};
  setPath(body, contract.polling.task_id_fields[0], taskID);
  if (status) setPath(body, contract.polling.status_fields[0], status);
  if (contract.polling.progress_fields[0]) setPath(body, contract.polling.progress_fields[0], status === contract.polling.success_statuses[0] ? 100 : 50);
  for (const path of resultFields) setPath(body, path, resultURL);
  return body;
}

function requestBody(input: NewAPIVideoPluginResult, sample: NewAPIVideoPluginResult["test_cases"][number]) {
  const body: Record<string, unknown> = { model: sample.model, prompt: "本地干跑示例" };
  const request = input.contract.request;
  const values = sample.input;
  const cap = (input.contract.model_profiles?.find(profile => profile.model === sample.model) || input.contract).capability;
  if (cap.prompt) body.prompt = "x".repeat(Math.max(1,cap.prompt.min_length));
  const parameters = values.parameters as Record<string,unknown> | undefined;
  for (const parameter of cap.parameters || []) {
    if (!parameter.modes?.length || parameter.modes.includes(sample.mode.kind)) {
      const value = parameters?.[parameter.name] ?? parameter.default;
      if (value != null) setPath(body, parameter.field, value);
    }
  }
  setPath(body, request.duration_field, request.duration_value_type === "string" ? String(values.duration) : values.duration);
  if (values.size) setPath(body, request.aspect_ratio_field, values.size);
  if (values.resolution) setPath(body, request.resolution_field, values.resolution);
  if (cap.audio_control !== "none") setPath(body, request.generate_audio_field, values.generate_audio);
  if (cap.watermark) setPath(body, request.watermark_field, values.watermark);
  setPath(body, request.generation_mode_field, sample.mode.request_value || sample.mode.id);
  for (const [key, path, extension] of [
    ["first_frame", request.first_frame_field, "png"], ["last_frame", request.last_frame_field, "png"],
    ["reference_image", request.reference_images_field, "png"], ["reference_video", request.reference_videos_field, "mp4"],
    ["reference_audio", request.reference_audios_field, "mp3"],
  ]) {
    const count = Number(values[key]);
    if (!count) continue;
    const url = `https://dry-run.invalid/${key}.${extension}`;
    setPath(body, path, key.startsWith("reference_") && request.reference_value_type !== "scalar" ? Array.from({ length: count }, () => url) : url);
  }
  return body;
}

export function runNewAPIVideoPluginDryRun(plugin: GeneratedVideoPlugin, input: NewAPIVideoPluginResult): string[] {
  const { models, auth_mode: authMode, auth_header: authHeader, download_mode: downloadMode, result_fields: resultFields } = input.options;
  assert(plugin.meta.apiVersion === 1, "插件 API 版本不是 v1");
  assert(plugin.meta.protocols.length === 1 && plugin.meta.protocols[0] === "openai_video", "插件协议未限制为 openai_video");
  assert(!plugin.meta.routes, "插件不应暴露额外原生路由");
  assert(JSON.stringify(plugin.meta.models) === JSON.stringify(models), "插件公开模型与配置不一致");
  assert(plugin.meta.auth === (authMode === "none" ? "none" : "api_key"), "插件鉴权声明与配置不一致");
  assert(input.options.base_url ? plugin.meta.baseUrl === input.options.base_url : !Object.hasOwn(plugin.meta, "baseUrl"), "插件默认地址与配置不一致");
  const channelBaseURL = "https://dry-run.invalid/channel";
  const checks = ["插件模块可加载", "插件协议与模型声明"];
  const originalFetch = globalThis.fetch;
  const workerGlobal = globalThis as typeof globalThis & { utils?: { fetch: () => { status: number; body: Record<string, unknown> } } };
  globalThis.fetch = (() => { throw new Error("dry-run blocked direct network access"); }) as typeof fetch;
  workerGlobal.utils = { fetch: () => ({ status: 200, body: responseBody(input.contract, input.contract.polling.success_statuses[0], "dry-run-task", resultFields, "https://dry-run.invalid/video.mp4") }) };
  try {
    assert(input.test_cases.length > 0, "插件缺少干跑测试样本");
    for (const model of models) {
      const profile = input.contract.model_profiles?.find(item => item.model === model) || input.contract;
      for (const mode of profile.generation.modes) {
        assert(input.test_cases.some(sample => sample.model === model && sample.mode.id === mode.id), `模型 ${model} 的模式 ${mode.id} 缺少测试样本`);
      }
    }
    for (const sample of input.test_cases) {
      const { model, mode } = sample;
      const body = requestBody(input, sample);
      const baseContext: Record<string, unknown> = {
        requestBody: body,
        upstreamModel: model,
        model,
        baseUrl: channelBaseURL,
        apiKey: "dry-run-key",
        files: [],
      };
      const submit = plugin.buildSubmitRequest(baseContext);
      assert(submit.method === "POST" && submit.url === channelBaseURL + input.contract.transport.create_path, `模型 ${model} 的创建请求未使用渠道地址或路径无效`);
      assert(submit.body && typeof submit.body === "object", `模型 ${model} 的创建请求没有 JSON body`);
      const expectedBody = requestBody(input, {...sample, input: sample.expected});
      const canonical = (value: unknown): string => JSON.stringify(value, function (_key, item) {
        return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item;
      });
      assert(canonical(submit.body) === canonical(expectedBody), `模型 ${model} 的实际出站请求与契约不一致（参数、类型、强制值或素材编码错误）`);
      if (authMode === "bearer") assert(submit.headers.Authorization === "Bearer dry-run-key", `模型 ${model} 的 Bearer 鉴权无效`);
      if (authMode === "header") assert(submit.headers[authHeader] === "dry-run-key", `模型 ${model} 的自定义 Key 请求头无效`);
      if (authMode === "none") assert(!Object.keys(submit.headers).some((header) => header.toLowerCase() === "authorization"), `模型 ${model} 的免鉴权请求错误携带了 Key`);
      const decoded = plugin.protocols.openai_video.decodeRequest({ model, body: { kind: "json", value: body } });
      assert(decoded.kind === "submit" && decoded.model === model && decoded.action === (mode.kind === "text" ? "text_to_video" : "image_to_video"), `模型 ${model} 的 OpenAI 视频解码失败`);
      const alias = "dry-run-client-alias";
      const aliasBody = {...body, model: alias};
      const aliasDecoded = plugin.protocols.openai_video.decodeRequest({model: alias, upstreamModel: model, body: {kind: "json", value: aliasBody}});
      assert(aliasDecoded.model === alias, `模型 ${model} 的解码结果改写了客户端模型别名`);
      const aliasSubmit = plugin.buildSubmitRequest({...baseContext, model: alias, requestBody: aliasDecoded.requestBody});
      assert(canonical(aliasSubmit.body) === canonical(expectedBody), `模型 ${model} 的渠道模型映射改变了实际请求或用量参数`);
      if (input.contract.transport.local_material === "multipart" && mode.kind !== "text") {
        const fields: Record<string,string[]> = {};
        const uploadBody = structuredClone(body);
        const files: Array<{ref:string;field:string;filename:string;mimeType:string;size:number}> = [];
        const request = input.contract.request;
        const paths = [
          ["first_frame",request.first_frame_field,"image/png","png"], ["last_frame",request.last_frame_field,"image/png","png"],
          ["reference_image",request.reference_images_field,"image/png","png"], ["reference_video",request.reference_videos_field,"video/mp4","mp4"], ["reference_audio",request.reference_audios_field,"audio/mpeg","mp3"],
        ] as const;
        for (const [role,path,mimeType,extension] of paths) {
          const count = Number(sample.input[role]);
          if (!count) continue;
          const fileField = input.contract.transport.multipart_fields?.[role] || input.contract.transport.multipart_file_field;
          const refs = Array.from({length:count},(_,index)=>{
            const ref = `request_file:${role}#${index}`;
            files.push({ref,field:fileField,filename:`${role}-${index}.${extension}`,mimeType,size:16});
            return ref;
          });
          setPath(uploadBody,path,role.startsWith("reference_") && request.reference_value_type !== "scalar" ? refs : refs[0]);
          const segments = path.replace(/\[([0-9]+)\]/g,".$1").split(".");
          const parents: Record<string,unknown>[] = [uploadBody];
          for (const part of segments.slice(0,-1)) parents.push(parents.at(-1)![part] as Record<string,unknown>);
          for (let i = segments.length-1; i >= 0; i--) {
            const parent = parents[i];
            delete parent[segments[i]];
            if (Array.isArray(parent)) while (parent.length && parent.at(-1) == null) parent.pop();
            if (Object.keys(parent).length) break;
          }
        }
        for (const [name,value] of Object.entries(uploadBody)) fields[name] = [typeof value === "object" ? JSON.stringify(value) : String(value)];
        const intent = plugin.protocols.openai_video.decodeRequest({model,body:{kind:"multipart",fields,files}});
        const multipart = plugin.buildSubmitRequest({...baseContext,requestBody:intent.requestBody,files});
        assert(multipart.bodyType === "multipart" && multipart.parts?.length, `模型 ${model} 未生成 multipart 请求`);
        for (const file of files) assert(multipart.parts.filter(part=>part.fileRef===file.ref && part.name===file.field).length===1, `模型 ${model} 文件字段路由错误`);
        assert(!Object.keys(multipart.headers).some(name=>name.toLowerCase()==="content-type"), "multipart boundary 必须由宿主生成");
        checks.push(`${model}：${mode.label}文件上传字段路由`);
      }
      const usage = plugin.extractUsage({ ...baseContext, usagePurpose: "facts" });
      assert(usage.seconds === sample.expected.duration, `模型 ${model} 的时长用量与契约强制规则不一致`);
      const taskID = "dry-run-task";
      const query = plugin.buildQueryRequest({ ...baseContext, taskId: taskID });
      assert(query.method === "GET" && query.url.startsWith(channelBaseURL + "/"), `模型 ${model} 的查询请求未使用渠道地址或路径无效`);
      const submitted = plugin.parseSubmitResponse({}, { body: responseBody(input.contract, "", taskID, [], "") });
      assert(submitted.taskId === taskID, `模型 ${model} 的创建响应任务 ID 解析失败`);
      for (const [statuses, expected] of [
        [input.contract.polling.queued_statuses, "QUEUED"], [input.contract.polling.processing_statuses, "IN_PROGRESS"],
        [input.contract.polling.success_statuses, "SUCCESS"], [input.contract.polling.failure_statuses, "FAILURE"],
      ] as const) {
        for (const status of statuses) {
          const response = responseBody(input.contract, status, taskID, expected === "SUCCESS" ? resultFields : [], "https://dry-run.invalid/video.mp4");
          assert(plugin.parseTaskResult({ taskId: taskID }, response).status === expected, `模型 ${model} 的状态 ${status} 映射失败`);
        }
      }
      const unknown = responseBody(input.contract, "dry-run-unknown-status", taskID, [], "");
      assert(plugin.parseTaskResult({ taskId: taskID }, unknown).status === "UNKNOWN", `模型 ${model} 错误接受未知状态`);
      const mismatched = responseBody(input.contract, input.contract.polling.success_statuses[0], "wrong-task", [], "");
      assert(plugin.parseTaskResult({ taskId: taskID }, mismatched).status === "UNKNOWN", `模型 ${model} 错误接受其他任务的结果`);
      if (input.contract.request.duration_field) {
        const invalid = structuredClone(body);
        setPath(invalid, input.contract.request.duration_field, true);
        let rejected = false;
        try { plugin.buildSubmitRequest({ ...baseContext, requestBody: invalid }); } catch { rejected = true; }
        assert(rejected, `模型 ${model} 未拒绝错误的时长类型`);
      }
      assert(plugin.listArtifacts({ status: "SUCCESS" }).some((item) => item.key === "video"), `模型 ${model} 的视频产物声明缺失`);
      const rendered = plugin.protocols.openai_video.render({}, { status: "SUCCESS", data: { api_key: "dry-run-key", video_url: "https://dry-run.invalid/video.mp4" } });
      assert(!JSON.stringify(rendered).includes("dry-run-key"), `模型 ${model} 的对外响应泄露渠道密钥`);

      if (downloadMode === "task_content") {
        const content = plugin.buildContentRequest({ ...baseContext, artifactKey: "video", upstreamTaskId: taskID, clientRequest: { method: "GET" } });
        assert(content.method === "GET" && content.url.includes("dry-run-task"), `模型 ${model} 的产物路径无效`);
      } else {
        const content = plugin.buildContentRequest({ ...baseContext, artifactKey: "video", upstreamTaskId: taskID, clientRequest: { method: "GET" } });
        assert(content.url === "https://dry-run.invalid/video.mp4", `模型 ${model} 的视频地址解析失败`);
        if (downloadMode === "signed_url" || authMode === "none") assert(content.credentialless === true, `模型 ${model} 的签名地址下载未隔离凭据`);
        if (downloadMode === "authenticated_url" && authMode !== "none") assert(Boolean(content.headers?.Authorization || content.headers?.[authHeader]), `模型 ${model} 的带 Key 下载缺少鉴权`);
      }
      checks.push(`${model}：${mode.label}创建、轮询、用量与下载流程`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete workerGlobal.utils;
  }
  return checks;
}
