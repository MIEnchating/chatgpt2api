import * as generated from './generated.js';

// One upstream contract retains each model's individual capability profile.
export const meta = {
  ...generated.meta,
  name: 'XZAPI StarFrame 视频',
  description: { zh: 'XZAPI 视频任务、素材数量编码与幂等提交', en: 'XZAPI video tasks with reference cardinality and idempotent submission' },
};

export function buildSubmitRequest(ctx) {
  // New API's public task ID stays stable across retries of the same gateway task.
  if (typeof ctx.publicTaskId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(ctx.publicTaskId)) {
    throw new Error('宿主必须提供有效的 publicTaskId 作为 XZAPI client_task_id');
  }
  const request = generated.buildSubmitRequest(ctx);
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

export const { protocols, extractUsage, parseSubmitResponse, buildQueryRequest, parseTaskResult, listArtifacts } = generated;

export function buildContentRequest(ctx) {
  const request = generated.buildContentRequest(ctx);
  // The provider documents GET only; New API suppresses the body for client HEAD requests.
  request.method = 'GET';
  return request;
}
