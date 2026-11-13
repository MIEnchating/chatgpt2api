import * as core from './core.js';

export const meta = core.meta;
export const protocols = core.protocols;
export const parseSubmitResponse = core.parseSubmitResponse;
export const buildQueryRequest = core.buildQueryRequest;
export const parseTaskResult = core.parseTaskResult;
export const listArtifacts = core.listArtifacts;
export const buildContentRequest = core.buildContentRequest;

const sizesByResolution = {
  '480p': ['854x480', '480x854', '1120x480', '640x480', '480x480', '480x640'],
  '720p': ['1280x720', '720x1280', '1680x720', '960x720', '720x720', '720x960'],
  '768p': ['1365x768', '768x1365', '1792x768', '1024x768', '768x768', '768x1024'],
  '960p': ['1707x960', '960x1707', '2240x960', '1280x960', '960x960', '960x1280'],
  '1080p': ['1920x1080', '1080x1920', '2520x1080', '1440x1080', '1080x1080', '1080x1440'],
};
const ratios = ['16:9', '9:16', '21:9', '4:3', '1:1', '3:4'];

function applyHiRunSize(request, ctx) {
  const inputs = ctx.requestBody || {};
  const aspectRatio = inputs.aspect_ratio || '16:9';
  const resolution = inputs.resolution || '720p';
  const size = sizesByResolution[resolution]?.[ratios.indexOf(aspectRatio)];
  if (!size) throw new Error('Hi.Run 不支持所选画幅或清晰度');
  if (request.bodyType === 'multipart') {
    request.parts = request.parts.filter(part => !['aspect_ratio', 'resolution'].includes(part.name));
    request.parts.push({ name: 'size', value: size });
    return request;
  }
  delete request.body.aspect_ratio;
  delete request.body.resolution;
  request.body.size = size;
  return request;
}

export function extractUsage(ctx) {
  const usage = core.extractUsage(ctx);
  const requestedResolution = ctx.requestBody?.resolution;
  const size = ctx.requestBody?.size;
  if (typeof requestedResolution === 'string' && Object.hasOwn(sizesByResolution, requestedResolution)) {
    usage.resolution = requestedResolution;
  } else if (typeof size === 'string') {
    const dimensions = size.split('x').map(Number);
    if (dimensions.length === 2 && dimensions.every(Number.isFinite)) {
      usage.resolution = `${Math.min(...dimensions)}p`;
    }
  }
  return usage;
}

export function buildSubmitRequest(ctx) {
  const request = applyHiRunSize(core.buildSubmitRequest(ctx), ctx);
  if (request.bodyType === 'multipart') {
    for (const part of request.parts) {
      if (part.name === 'duration') part.name = 'seconds';
    }
    return request;
  }
  if (Object.hasOwn(request.body, 'duration')) {
    request.body.seconds = request.body.duration;
    delete request.body.duration;
  }
  return request;
}
