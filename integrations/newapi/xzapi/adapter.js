import * as ch01 from './group-0.js';
import * as ch13 from './group-1.js';
import * as ch14 from './group-2.js';

// Generated modules embed the three importable contracts and all model profiles.
const groups = [ch01, ch13, ch14];
export const meta = {
  ...ch01.meta,
  key: 'xzapi-video',
  name: 'XZAPI StarFrame 视频',
  description: { zh: 'XZAPI 视频任务、素材数量编码与幂等提交', en: 'XZAPI video tasks with reference cardinality and idempotent submission' },
  models: groups.flatMap(group => group.meta.models),
  usageProfiles: [
    ...ch01.meta.usageProfiles,
    ...groups.slice(1).flatMap(group => [
      { models: [group.meta.models[0]], schema: group.meta.usageSchema },
      ...group.meta.usageProfiles,
    ]),
  ],
};

function groupFor(ctx) {
  const group = groups.find(group => group.meta.models.includes(ctx.upstreamModel))
    || groups.find(group => group.meta.models.includes(ctx.model));
  if (!group) throw new Error('模型不属于 XZAPI 插件');
  return group;
}

export function buildSubmitRequest(ctx) {
  // New API's public task ID stays stable across retries of the same gateway task.
  if (typeof ctx.publicTaskId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(ctx.publicTaskId)) {
    throw new Error('宿主必须提供有效的 publicTaskId 作为 XZAPI client_task_id');
  }
  const request = groupFor(ctx).buildSubmitRequest(ctx);
  request.body.mode = 'references';
  request.body.client_task_id = ctx.publicTaskId;
  const references = request.body.references;
  if (references) {
    for (const [plural, singular] of [['images', 'image'], ['videos', 'video'], ['audios', 'audio']]) {
      const values = references[plural];
      if (!values?.length) delete references[plural];
      else if (values.length === 1) {
        references[singular] = values[0];
        delete references[plural];
      }
    }
    if (Object.keys(references).length === 0) delete request.body.references;
  }
  return request;
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) { return groupFor(ctx).protocols.openai_video.decodeRequest(ctx); },
    render(ctx, task) { return ch01.protocols.openai_video.render(ctx, task); },
  },
};

export function extractUsage(ctx) { return groupFor(ctx).extractUsage(ctx); }
export function parseSubmitResponse(ctx, response) { return ch01.parseSubmitResponse(ctx, response); }
export function buildQueryRequest(ctx) { return ch01.buildQueryRequest(ctx); }
export function parseTaskResult(ctx, body) { return ch01.parseTaskResult(ctx, body); }
export function listArtifacts(task) { return ch01.listArtifacts(task); }
export function buildContentRequest(ctx) {
  const request = ch01.buildContentRequest(ctx);
  // The provider documents GET only; New API suppresses the body for client HEAD requests.
  request.method = 'GET';
  return request;
}
