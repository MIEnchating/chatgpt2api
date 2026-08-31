import type {
  ImageAPIMode,
  ImageModel,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  ImageQualityCheck,
  ImageVisibility,
} from "@/lib/api";
import type { GenerationMediaType, GenerationTaskStatus } from "@/lib/generation-task-contract";

export type ImageConversationMode = "chat" | "generate" | "image" | "edit" | "video";
type StoredReferenceImageSource = "upload" | "conversation";

export type StoredReferenceImage = {
  name: string;
  type: string;
  dataUrl: string;
  assetPath?: string;
  size?: number;
  source?: StoredReferenceImageSource;
};

export type StoredImage = {
  id: string;
  taskId?: string;
  taskRevision?: number;
  status?: "loading" | "success" | "error" | "cancelled" | "message";
  taskStatus?: GenerationTaskStatus;
  path?: string;
  visibility?: ImageVisibility;
  b64_json?: string;
  url?: string;
  storageKey?: string;
  mediaType?: GenerationMediaType;
  videoUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  resolution?: string;
  outputFormat?: ImageOutputFormat;
  qualityCheck?: ImageQualityCheck;
  taskCreatedAt?: string;
  taskUpdatedAt?: string;
  generationDurationMs?: number;
  revised_prompt?: string;
  error?: string;
  text_response?: string;
};

export type ImageTurnStatus = "queued" | "generating" | "success" | "error" | "cancelled" | "message";

export type StoredImageSizeSelection = {
  mode: string;
  aspectRatio: string;
  resolution: string;
  customRatio?: string;
  customWidth: string;
  customHeight: string;
};

export type ImageTurn = {
  id: string;
  source?: "image-workbench" | "workflow";
  workflowId?: string;
  workflowName?: string;
  workflowInputs?: Record<string, string>;
  workflowTaskId?: string;
  prompt: string;
  model: ImageModel;
  mode: ImageConversationMode;
  referenceImages: StoredReferenceImage[];
  count: number;
  size: string;
  sizeSelection?: StoredImageSizeSelection;
  quality?: ImageQuality;
  outputFormat?: ImageOutputFormat;
  outputCompression?: number;
  apiMode?: ImageAPIMode;
  imageSystemPrompt?: string;
  stream?: boolean;
  partialImages?: number;
  responseFormatB64JSON?: boolean;
  codexCLICompatibility?: boolean;
  videoSeconds?: number;
  videoResolution?: string;
  videoGenerateAudio?: boolean;
  videoWatermark?: boolean;
  videoReferenceMode?: "first-frame" | "reference";
  videoFirstFrameURL?: string;
  videoLastFrameURL?: string;
  videoReferenceImageURLs?: string[];
  videoReferenceVideoURLs?: string[];
  videoReferenceAudioURLs?: string[];
  videoSystemPrompt?: string;
  moderation?: ImageModeration;
  tokenGroup?: string;
  tokenName?: string;
  visibility?: ImageVisibility;
  images: StoredImage[];
  createdAt: string;
  processingStartedAt?: string;
  status: ImageTurnStatus;
  error?: string;
};

export type ImageConversationHistorySummary = {
  turnCount: number;
  queued: number;
  running: number;
};

export type ImageConversation = {
  id: string;
  revision?: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ImageTurn[];
  historySummaryOnly?: boolean;
  historySummary?: ImageConversationHistorySummary;
};

export type ImageConversationStats = {
  queued: number;
  running: number;
};

export type ImageTurnLoadingCounts = {
  queued: number;
  running: number;
};

export type ImageTurnLoadingPhase = "queued" | "running" | "idle";
