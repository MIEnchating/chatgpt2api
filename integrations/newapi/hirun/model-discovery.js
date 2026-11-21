import { meta as videoMeta } from './hirun-video-1.0.2.js';
import { videoModelList } from '../video-model-list.js';

export * from './hirun-video-1.0.2.js';

export const meta = {
  ...videoMeta,
  version: '1.1.0',
  relay: [{ incoming_path: '/v1/models', upstream_path: '/models', converter: 'plugin' }],
};

export const convertResponse = videoModelList(meta.models);
