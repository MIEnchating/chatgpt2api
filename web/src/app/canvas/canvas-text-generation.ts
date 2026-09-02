import type { CanvasNode } from "@/services/api/canvas";
import { resolveConfiguredModel } from "@/lib/model-config-selection";

export type CanvasTextGenerationPlan = {
  sourceContent: string;
  instruction: string;
  requestPrompt: string;
  count: number;
  createsChildNodes: boolean;
};

export function resolveCanvasTextModel(
  defaultModel: unknown,
  textModels: unknown,
) {
  return resolveConfiguredModel(textModels, defaultModel);
}

export function canvasTextGenerationPlan(sourceNode: CanvasNode): CanvasTextGenerationPlan {
  const sourceContent = sourceNode.type === "text" ? String(sourceNode.prompt || "").trim() : "";
  const instruction = String(sourceNode.composer_content ?? (sourceNode.type === "config" ? sourceNode.prompt : "") ?? "").trim();
  const editingTextNode = sourceNode.type === "text" && Boolean(sourceContent);
  const requestPrompt = editingTextNode
    ? `请根据要求修改以下文本。\n\n原文：\n${sourceContent}\n\n修改要求：\n${instruction}`
    : instruction;
  return {
    sourceContent,
    instruction,
    requestPrompt,
    count: sourceNode.type === "config" ? Math.max(1, Math.min(15, Math.floor(sourceNode.generation_count || 1))) : 1,
    createsChildNodes: sourceNode.type === "config" || editingTextNode,
  };
}
