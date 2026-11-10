import * as self from './group-0.js';
import * as spica from './group-1.js';
import * as chovy from './group-2.js';
import * as h3 from './group-3.js';
import * as superH3 from './group-4.js';

const groups = [self, spica, chovy, h3, superH3];

function countUsageSchema(resolutions) {
  return {
    count: {
      type: 'number',
      unit: 'count',
      unitLabel: { zh: '条', en: 'video' },
      description: { zh: '视频生成单价', en: 'Video generation unit price' },
    },
    resolution: {
      enum: resolutions,
      description: { zh: '输出清晰度', en: 'Output resolution' },
    },
  };
}

const spicaUsageSchema = countUsageSchema(spica.meta.usageSchema.resolution.enum);
const chovyUsageSchema = countUsageSchema(chovy.meta.usageSchema.resolution.enum);
const superH3UsageSchema = countUsageSchema(superH3.meta.usageSchema.resolution.enum);

export const meta = {
  ...self.meta,
  key: 'openai-fit-minimax',
  name: 'openai.fit MiniMax 视频',
  description: { zh: '内嵌五个 MiniMax 视频契约，支持参考素材、任务查询和成片下载', en: 'Five embedded MiniMax video contracts with references, polling and content downloads' },
  models: groups.flatMap(group => group.meta.models),
  usageProfiles: [
    { models: spica.meta.models, schema: spicaUsageSchema },
    { models: chovy.meta.models, schema: chovyUsageSchema },
    { models: h3.meta.models, schema: h3.meta.usageSchema },
    { models: superH3.meta.models, schema: superH3UsageSchema },
  ],
};

function groupFor(ctx) {
  const group = groups.find(group => group.meta.models.includes(ctx.upstreamModel))
    || groups.find(group => group.meta.models.includes(ctx.model));
  if (!group) throw new Error('模型不属于 openai.fit MiniMax 插件');
  return group;
}

export function buildSubmitRequest(ctx) {
  const group = groupFor(ctx);
  const request = group.buildSubmitRequest(ctx);
  if (group === self) {
    // The provider combines resolution and orientation into one enum.
    // The gateway contract uses an array; the provider uses numbered fields.
    if (request.bodyType === 'multipart') {
      let index = 0;
      const ratio = request.parts.find(part => part.name === 'ratio').value;
      const resolution = request.parts.find(part => part.name === 'resolution');
      resolution.value += ratio === '9:16' ? '竖' : '横';
      request.parts = request.parts.filter(part => part.name !== 'ratio');
      for (const part of request.parts) {
        if (part.fileRef && part.name === 'image_urls') part.name = `ref_image_${index++}`;
      }
    } else {
      request.body.resolution += request.body.ratio === '9:16' ? '竖' : '横';
      delete request.body.ratio;
      for (const [index, url] of (request.body.image_urls || []).entries()) request.body[`ref_image_${index}`] = url;
      delete request.body.image_urls;
    }
    return request;
  }
  for (const field of ['image_urls', 'audio_urls']) {
    for (const url of request.body[field] || []) {
      if (!url.startsWith('https://')) throw new Error('此模型的参考素材必须使用公网 HTTPS 链接');
    }
  }
  if (group === chovy) {
    const audios = request.body.audio_urls || [];
    for (const match of request.body.prompt.matchAll(/<Audio (\d+)>/g)) {
      const index = Number(match[1]);
      if (index < 1 || index > audios.length) throw new Error('提示词引用的音频缺少对应素材');
    }
  }
  return request;
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) { return groupFor(ctx).protocols.openai_video.decodeRequest(ctx); },
    render(ctx, task) { return self.protocols.openai_video.render(ctx, task); },
  },
};
export function extractUsage(ctx) {
  if (ctx.usagePurpose === 'billing_ratios') return {};
  const group = groupFor(ctx);
  const usage = group.extractUsage(ctx);
  if (group === spica || group === chovy || group === superH3) return { count: 1, resolution: usage.resolution };
  return usage;
}
export function parseSubmitResponse(ctx, response) { return self.parseSubmitResponse(ctx, response); }
export function buildQueryRequest(ctx) { return self.buildQueryRequest(ctx); }
export function parseTaskResult(ctx, body) { return self.parseTaskResult(ctx, body); }
export function listArtifacts(task) { return self.listArtifacts(task); }
export function buildContentRequest(ctx) { return self.buildContentRequest(ctx); }
