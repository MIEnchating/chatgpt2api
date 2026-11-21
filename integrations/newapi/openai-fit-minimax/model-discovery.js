import { meta as videoMeta } from './openai-fit-minimax-video-1.1.0.js';
import { videoModelList } from '../video-model-list.js';

export * from './openai-fit-minimax-video-1.1.0.js';

export const meta = {
  ...videoMeta,
  version: '1.3.0',
  relay: [{ incoming_path: '/v1/models', upstream_path: '/v1/models', converter: 'plugin' }],
};

export const convertResponse = videoModelList(meta.models);
