import type { CanvasConnection, CanvasNode } from "@/lib/api";

export const CANVAS_CONFIG_REFERENCE_PATTERN = /@\[node:([^\]]+)\]/g;

export type CanvasConfigInput = {
  nodeID: string;
  type: "image" | "text";
  title: string;
  text?: string;
  url?: string;
};

export function canvasConfigInputs(
  configNodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return connections
    .filter((connection) => connection.to_node_id === configNodeID)
    .flatMap((connection): CanvasConfigInput[] => {
      const node = nodeByID.get(connection.from_node_id);
      if (node?.type === "image" && String(node.url || "").trim()) {
        return [{ nodeID: node.id, type: "image", title: node.title || "图片", url: String(node.url).trim() }];
      }
      if (node && node.type !== "config" && String(node.prompt || "").trim()) {
        return [{ nodeID: node.id, type: "text", title: node.title || "想法", text: String(node.prompt).trim() }];
      }
      return [];
    });
}

export function canvasGenerationInputs(
  nodeID: string,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const configConnection = connections.find((connection) => (
    connection.from_node_id === nodeID
    && nodeByID.get(connection.to_node_id)?.type === "config"
  ));
  if (configConnection) {
    const configInputs = canvasConfigInputs(configConnection.to_node_id, nodes, connections)
      .filter((input) => input.nodeID !== nodeID);
    if (configInputs.length) return configInputs;
  }
  return canvasConfigInputs(nodeID, nodes, connections);
}

export function canvasConfigInputLabel(input: CanvasConfigInput, inputs: readonly CanvasConfigInput[]) {
  const index = inputs.filter((candidate) => candidate.type === input.type).findIndex((candidate) => candidate.nodeID === input.nodeID);
  return `${input.type === "image" ? "图片" : "文本"}${Math.max(0, index) + 1}`;
}

export function canGenerateCanvasConfig(node: CanvasNode, inputs: readonly CanvasConfigInput[]) {
  return Boolean(
    String(node.composer_content ?? node.prompt ?? "").trim()
    || inputs.some((input) => Boolean(input.text || input.url)),
  );
}

export function canvasConfigPromptDisplay(value: string, inputs: readonly CanvasConfigInput[]) {
  const inputByID = new Map(inputs.map((input) => [input.nodeID, input]));
  return value.replace(CANVAS_CONFIG_REFERENCE_PATTERN, (token, nodeID: string) => {
    const input = inputByID.get(nodeID);
    return input ? `@${canvasConfigInputLabel(input, inputs)}` : token;
  });
}

export function canvasConfigPromptValue(value: string, inputs: readonly CanvasConfigInput[]) {
  const idByLabel = new Map(inputs.map((input) => [canvasConfigInputLabel(input, inputs), input.nodeID]));
  return value.replace(/@(图片|文本)\d+/g, (label) => {
    const nodeID = idByLabel.get(label.slice(1));
    return nodeID ? `@[node:${nodeID}]` : label;
  });
}

export function insertCanvasConfigReference(value: string, label: string, start: number, end: number) {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const inserted = `${prefix}@${label}${suffix || " "}`;
  return { value: `${before}${inserted}${after}`, cursor: before.length + inserted.length };
}
