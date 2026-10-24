import type { VideoContractAgentDetail, VideoModelContractImportProgress } from "./api";

export const VIDEO_CONTRACT_IMPORT_STEPS = ["读取文档", "匹配协议", "生成配置", "校验请求", "整理草稿"] as const;

export type VideoContractImportActivity = VideoModelContractImportProgress & {
  step: number;
  completedSteps: number[];
  connected: boolean;
};

export function updateVideoContractImportActivity(
  current: VideoContractImportActivity | null,
  event: VideoModelContractImportProgress,
): VideoContractImportActivity {
  const previous = current ?? { ...event, step: 0, completedSteps: [], connected: false };
  if (event.stage === "heartbeat") {
    return { ...previous, connected: true, elapsed_seconds: event.elapsed_seconds };
  }
  let step = previous.step;
  const completedSteps = new Set(previous.completedSteps);
  const detail = event.detail;
  switch (event.stage) {
    case "reading_document":
    case "reading_documents":
    case "planning_documents": step = 0; break;
    case "document_ready": completedSteps.add(0); break;
    case "preparing":
    case "matching_protocol": step = 1; break;
    case "generating": step = 2; break;
    case "validating":
    case "dry_run": step = 3; break;
    case "completed":
      step = 4;
      VIDEO_CONTRACT_IMPORT_STEPS.forEach((_, index) => completedSteps.add(index));
      break;
  }
  if (detail?.kind === "tool") {
    const toolStep = { read_documents: 0, inspect_protocols: 1, validate_contracts: 3, finish: 4 }[detail.name];
    if (toolStep !== undefined) {
      step = toolStep;
      if (detail.name === "validate_contracts") completedSteps.add(2);
      if (detail.status === "completed") completedSteps.add(step);
      else completedSteps.delete(step);
    }
  }
  if (event.document_revision !== undefined && event.document_revision > (previous.document_revision ?? 0)) {
    [2, 3, 4].forEach(index => completedSteps.delete(index));
  }
  if (event.validation_current === false) {
    [3, 4].forEach(index => completedSteps.delete(index));
  }
  const newRound = event.attempt !== undefined && event.attempt !== previous.attempt;
  const newRequest = event.request_attempt !== undefined && event.request_attempt !== previous.request_attempt;
  return {
    ...previous,
    received_characters: newRound || newRequest ? 0 : previous.received_characters,
    request_attempt: newRound ? undefined : previous.request_attempt,
    max_request_attempts: newRound ? undefined : previous.max_request_attempts,
    ...event, step, completedSteps: [...completedSteps], connected: true,
  };
}

export function updateVideoContractAgentDetails(current: VideoContractAgentDetail[], detail: VideoContractAgentDetail): VideoContractAgentDetail[] {
  const index = current.findIndex((entry) => entry.id === detail.id);
  if (index < 0) return [...current, detail].slice(-60);
  return current.map((entry, entryIndex) => entryIndex === index ? detail : entry);
}
