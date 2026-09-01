import type { CanvasConnection, CanvasNode } from "@/services/api/canvas";

export const CANVAS_CONFIG_REFERENCE_PATTERN = /@\[node:([^\]]+)\]/g;

export type CanvasConfigInput = {
  nodeID: string;
  type: "image" | "video" | "audio" | "text";
  title: string;
  text?: string;
  url?: string;
};

export type CanvasInputIndex = {
  nodeByID: Map<string, CanvasNode>;
  configInputsByNodeID: Map<string, CanvasConfigInput[]>;
  configTargetBySourceID: Map<string, string>;
};

export function buildCanvasInputIndex(
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
): CanvasInputIndex {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const configInputsByNodeID = new Map<string, CanvasConfigInput[]>();
  const configTargetBySourceID = new Map<string, string>();
  connections.forEach((connection) => {
    const source = nodeByID.get(connection.from_node_id);
    const target = nodeByID.get(connection.to_node_id);
    if (!configTargetBySourceID.has(connection.from_node_id) && target?.type === "config") {
      configTargetBySourceID.set(connection.from_node_id, connection.to_node_id);
    }
    let input: CanvasConfigInput | null = null;
    if (source?.type === "image" && String(source.url || "").trim()) {
      input = { nodeID: source.id, type: "image", title: source.title || "图片", url: String(source.url).trim() };
    } else if (source?.type === "panorama" && String(source.url || "").trim()) {
      input = { nodeID: source.id, type: "image", title: source.title || "全景图", url: String(source.url).trim() };
    } else if ((source?.type === "video" || source?.type === "audio") && String(source.url || "").trim()) {
      input = { nodeID: source.id, type: source.type, title: source.title || (source.type === "video" ? "视频" : "音频"), url: String(source.url).trim() };
    } else if (source?.type === "text" && String(source.prompt || "").trim()) {
      input = { nodeID: source.id, type: "text", title: source.title || "文字", text: String(source.prompt).trim() };
    }
    if (!input) return;
    const inputs = configInputsByNodeID.get(connection.to_node_id);
    if (inputs) inputs.push(input);
    else configInputsByNodeID.set(connection.to_node_id, [input]);
  });
  return { nodeByID, configInputsByNodeID, configTargetBySourceID };
}

export function canvasGenerationInputsFromIndex(nodeID: string, index: CanvasInputIndex) {
  const configNodeID = index.configTargetBySourceID.get(nodeID);
  if (configNodeID) {
    const inputs = (index.configInputsByNodeID.get(configNodeID) || []).filter((input) => input.nodeID !== nodeID);
    if (inputs.length) return inputs;
  }
  return index.configInputsByNodeID.get(nodeID) || [];
}

export function canvasConfigInputs(
  configNodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  return buildCanvasInputIndex(nodes, connections).configInputsByNodeID.get(configNodeID) || [];
}

export function canvasGenerationInputs(
  nodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  return canvasGenerationInputsFromIndex(nodeID, buildCanvasInputIndex(nodes, connections));
}

export function canvasConfigInputLabel(input: CanvasConfigInput, inputs: readonly CanvasConfigInput[]) {
  const index = inputs.filter((candidate) => candidate.type === input.type).findIndex((candidate) => candidate.nodeID === input.nodeID);
  return `${{ image: "图片", video: "视频", audio: "音频", text: "文本" }[input.type]}${Math.max(0, index) + 1}`;
}

export function canvasConfigUsesConnectedText(inputs: readonly CanvasConfigInput[]) {
  return inputs.some((input) => input.type === "text" && Boolean(input.text?.trim()));
}

export function canGenerateCanvasConfig(node: CanvasNode, inputs: readonly CanvasConfigInput[]) {
  const hasComposerContent = Boolean(String(node.composer_content ?? node.prompt ?? "").trim());
  if (node.composer_content !== undefined) return hasComposerContent;
  if (node.generation_mode === "audio") {
    return hasComposerContent || inputs.some((input) => input.type === "text" && Boolean(input.text));
  }
  return hasComposerContent || inputs.some((input) => Boolean(input.text || input.url));
}

export function canvasConfigPromptDisplay(value: string, inputs: readonly CanvasConfigInput[]) {
  const inputByID = new Map(inputs.map((input) => [input.nodeID, input]));
  return value.replace(CANVAS_CONFIG_REFERENCE_PATTERN, (token, nodeID: string) => {
    const input = inputByID.get(nodeID);
    return input ? `@${canvasConfigInputLabel(input, inputs)}` : token;
  });
}
