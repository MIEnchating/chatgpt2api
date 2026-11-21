import * as core from './core.js';
import modelMapping from './model-mapping.json';

export const meta = {
  ...core.meta,
  description: { zh: '异步视频任务', en: 'Asynchronous video tasks' },
  relay: [{ incoming_path: '/v1/models', upstream_path: '/v1/models', converter: 'plugin' }],
};

export const { protocols, extractUsage, parseSubmitResponse, buildQueryRequest, parseTaskResult, listArtifacts } = core;

export function convertResponse(_ctx, response) {
  if (response.status !== 200) {
    const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
    return { error: { status, message: '上游模型列表请求失败' } };
  }
  const body = JSON.parse(response.body);
  if (!Array.isArray(body?.data)) throw new Error('上游模型列表必须包含 data 数组');
  const available = new Set(body.data.map(model => model?.id));
  const data = Object.entries(modelMapping).flatMap(([id, upstream]) =>
    available.has(upstream) ? [{ id, object: 'model' }] : []);
  return { body: { object: 'list', data } };
}

export function buildSubmitRequest(ctx) {
  const upstream = modelMapping[ctx.model];
  if (!upstream) throw new Error('视频模型未配置');
  if (ctx.upstreamModel !== ctx.model && ctx.upstreamModel !== upstream) {
    throw new Error('渠道模型映射与视频契约不一致');
  }
  if (typeof ctx.publicTaskId !== 'string' || !/^[A-Za-z0-9_.-]{1,58}$/.test(ctx.publicTaskId)) {
    throw new Error('宿主必须提供有效的 out_task_id');
  }
  const request = core.buildSubmitRequest(ctx);
  const { first_frame, last_frame, references, ...body } = request.body;
  const assets = [];
  if (first_frame) assets.push({ type: 'image', role: 'first_frame', url: first_frame });
  if (last_frame) assets.push({ type: 'image', role: 'last_frame', url: last_frame });
  for (const [type, key] of [['image', 'images'], ['video', 'videos'], ['audio', 'audios']]) {
    for (const url of references?.[key] || []) assets.push({ type, role: 'reference', url });
  }
  request.body = {
    ...body, model: upstream, out_task_id: 'video_' + ctx.publicTaskId,
    ...(assets.length ? { references: assets } : {}),
  };
  return request;
}

export function buildContentRequest(ctx) {
  const request = core.buildContentRequest(ctx);
  // AIGASAPI documents a GET on the OSS response URL, including for proxy HEAD.
  return { ...request, method: 'GET' };
}
