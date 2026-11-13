import * as minimax from './group-0.js';

function isH3Self(model) {
  return model === 'minimax H3-self';
}

function groupFor(ctx) {
  const model = minimax.meta.models.includes(ctx.upstreamModel) ? ctx.upstreamModel : ctx.model;
  if (!minimax.meta.models.includes(model)) throw new Error('模型不属于 openai.fit MiniMax 插件');
  return model;
}

export const meta = {
  ...minimax.meta,
  name: 'openai.fit MiniMax 视频',
  description: { zh: '一个上游契约覆盖五个 MiniMax 视频型号', en: 'One upstream contract for five MiniMax video models' },
};

export function buildSubmitRequest(ctx) {
  const model = groupFor(ctx);
  const request = minimax.buildSubmitRequest(ctx);
  if (isH3Self(model)) {
    // H3-self combines resolution and orientation and numbers reference image fields.
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
  if (model === 'minimax-h3-chovy') {
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
    decodeRequest(ctx) { return minimax.protocols.openai_video.decodeRequest(ctx); },
    render(ctx, task) { return minimax.protocols.openai_video.render(ctx, task); },
  },
};

export const extractUsage = minimax.extractUsage;
export const parseSubmitResponse = minimax.parseSubmitResponse;
export const buildQueryRequest = minimax.buildQueryRequest;
export const parseTaskResult = minimax.parseTaskResult;
export const listArtifacts = minimax.listArtifacts;
export const buildContentRequest = minimax.buildContentRequest;
