import * as video from './xzapi-video-1.0.0.js';
import * as additionalVideo from './adapter.js';

export {
  parseTaskResult, parseSubmitResponse, listArtifacts, buildQueryRequest, buildContentRequest,
} from './xzapi-video-1.0.0.js';

const perRequestModels = ['ch1306-sd-2.0-480p', 'ch1306-sd-2.0-720p'];
const additionalModels = new Set(additionalVideo.meta.models);

export const meta = {
  ...video.meta,
  version: '1.4.0',
  models: [...video.meta.models, ...additionalVideo.meta.models],
  usageProfiles: [
    ...video.meta.usageProfiles.flatMap(profile => {
      const models = profile.models.filter(model => !perRequestModels.includes(model));
      return models.length ? [{ ...profile, models }] : [];
    }),
    {
      models: perRequestModels,
      schema: {
        count: {
          type: 'number',
          unit: 'count',
          unitLabel: { en: 'request', zh: '次' },
          description: { en: 'Video generation unit price', zh: '视频生成单价' },
        },
      },
    },
    { models: [additionalVideo.meta.models[0]], schema: additionalVideo.meta.usageSchema },
    ...additionalVideo.meta.usageProfiles,
  ],
  relay: [{ incoming_path: '/v1/models', upstream_path: '/v1/models', converter: 'plugin' }],
};

const supportedModels = new Set(meta.models);

function videoDriver(ctx) {
  const model = supportedModels.has(ctx.upstreamModel) ? ctx.upstreamModel : ctx.model;
  return additionalModels.has(model) ? additionalVideo : video;
}

export const protocols = {
  openai_video: {
    ...video.protocols.openai_video,
    decodeRequest(ctx) {
      return videoDriver(ctx).protocols.openai_video.decodeRequest(ctx);
    },
  },
};

export function buildSubmitRequest(ctx) {
  return videoDriver(ctx).buildSubmitRequest(ctx);
}

export function extractUsage(ctx) {
  const usage = videoDriver(ctx).extractUsage(ctx);
  const model = supportedModels.has(ctx.upstreamModel) ? ctx.upstreamModel : ctx.model;
  if (ctx.usagePurpose !== 'billing_ratios' && perRequestModels.includes(model)) {
    return { count: 1 };
  }
  return usage;
}

export function convertResponse(_ctx, response) {
  if (response.status !== 200) {
    return { error: { status: response.status, message: 'XZAPI model listing request failed' } };
  }
  const { data } = JSON.parse(response.body);
  if (!Array.isArray(data)) {
    throw new Error('XZAPI model list must contain a data array');
  }
  // Each video model needs a task capability profile before the plugin can serve it.
  return { body: { object: 'list', data: data.filter(model => supportedModels.has(model?.id)) } };
}
