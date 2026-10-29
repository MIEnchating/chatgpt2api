import actionLabels from "../../../../../internal/service/canvas_agent_assets/labels.json";
import toolDefinitions from "../../../../../internal/service/canvas_agent_assets/tools.json";
import { nanoid } from "nanoid";

import type { CanvasAgentPhase } from "./canvas-agent-types";

const CANVAS_AGENT_ACTION_NAMES = [
  "get_canvas_summary",
  "get_selected_nodes",
  "query_canvas_nodes",
  "read_skill_file",
  "get_node",
  "get_reference",
  "list_references",
  "get_upstream_nodes",
  "get_downstream_nodes",
  "get_connected_nodes",
  "get_generation_config",
  "get_generation_task",
  "set_agent_state",
  "ask_user_question",
  "update_plan",
  "create_primary_script_node",
  "create_text_node",
  "update_text_node",
  "update_node",
  "delete_node",
  "create_connection",
  "delete_connection",
  "create_group",
  "arrange_nodes",
  "generate_image",
  "edit_image",
  "generate_video",
  "generate_audio",
  "generate_node",
  "get_media_task_status",
  "list_workflows",
  "get_workflow",
  "save_workflow",
  "run_saved_workflow",
  "create_canvas_workflow",
  "run_canvas_workflow",
] as const;

type CanvasAgentActionName = (typeof CANVAS_AGENT_ACTION_NAMES)[number];

export type CanvasAgentAction = {
  id: string;
  name: CanvasAgentActionName;
  arguments: Record<string, unknown>;
};

export type CanvasAgentToolResult = {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
};

export type CanvasAgentToolDefinition = {
  type: "function";
  function: {
    name: CanvasAgentActionName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: false;
    };
  };
};

const PHASES: CanvasAgentPhase[] = ["intake", "concept", "script", "breakdown", "references", "storyboard", "video", "audio", "review", "complete"];
const ACTION_NAMES = new Set<string>(CANVAS_AGENT_ACTION_NAMES);
export const CANVAS_AGENT_TOOLS: CanvasAgentToolDefinition[] = toolDefinitions.filter((tool) => tool.function.name !== "read_skill_file" && ACTION_NAMES.has(tool.function.name)) as CanvasAgentToolDefinition[];
export const CANVAS_AGENT_SKILL_FILE_TOOL = toolDefinitions.find((tool) => tool.function.name === "read_skill_file") as CanvasAgentToolDefinition;

export function normalizeCanvasAgentAction(name: unknown, args: unknown, id = nanoid()): CanvasAgentAction {
  if (typeof name !== "string" || !ACTION_NAMES.has(name)) throw new Error("模型返回了不允许的工具");
  if (!isRecord(args)) throw new Error("工具 arguments 必须是 JSON 对象");
  const definition = name === "read_skill_file" ? CANVAS_AGENT_SKILL_FILE_TOOL : CANVAS_AGENT_TOOLS.find((item) => item.function.name === name)!;
  validateCanvasAgentArguments(args, definition.function.parameters);
  const input = args;
  const actionName = name as CanvasAgentActionName;
  let normalized: Record<string, unknown> = {};
  switch (actionName) {
    case "ask_user_question": {
      const options = stringArray(input.options);
      if (options.length !== (input.options as string[]).length) throw new Error("提问选项不得重复或为空");
      normalized = { question: requiredString(input.question, "question"), reason: requiredString(input.reason, "reason"), options, kind: input.kind, ...(input.purpose === "media_generation" || input.purpose === "workflow_review" ? { purpose: input.purpose } : {}) };
      break;
    }
    case "update_plan": {
      const steps = (input.steps as Array<Record<string, unknown>>).map((step) => ({ id: requiredString(step.id, "id"), title: requiredString(step.title, "title"), status: step.status }));
      if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error("计划步骤 ID 不得重复");
      if (steps.filter((step) => step.status === "in_progress").length > 1) throw new Error("最多一个计划步骤进行中");
      normalized = { explanation: optionalString(input.explanation), steps };
      break;
    }
    case "query_canvas_nodes":
      normalized = { ...input, page: input.page ?? 1, pageSize: input.pageSize ?? 20 };
      break;
    case "list_references":
      normalized = { ...(typeof input.keyword === "string" ? { keyword: input.keyword } : {}), page: Math.max(1, Number(input.page) || 1), pageSize: Math.min(50, Math.max(1, Number(input.pageSize) || 20)) };
      break;
    case "get_reference":
      normalized = { referenceId: requiredString(input.referenceId, "referenceId") };
      break;
    case "read_skill_file":
      normalized = { skillId: requiredString(input.skillId, "skillId"), path: requiredString(input.path, "path") };
      break;
    case "get_canvas_summary":
    case "get_selected_nodes":
    case "get_generation_config":
      break;
    case "get_node":
    case "get_upstream_nodes":
    case "get_downstream_nodes":
    case "get_connected_nodes":
    case "get_generation_task":
    case "get_media_task_status":
    case "generate_node":
    case "delete_node":
      normalized = { nodeId: requiredString(input.nodeId, "nodeId") };
      break;
    case "delete_connection":
      normalized = { connectionId: requiredString(input.connectionId, "connectionId") };
      break;
    case "create_connection":
      normalized = { fromNodeId: requiredString(input.fromNodeId, "fromNodeId"), toNodeId: requiredString(input.toNodeId, "toNodeId") };
      break;
    case "create_primary_script_node":
      normalized = { title: requiredString(input.title, "title"), content: requiredString(input.content, "content"), sourceNodeIds: stringArray(input.sourceNodeIds), projectTitle: requiredString(input.projectTitle, "projectTitle") };
      break;
    case "create_text_node":
      normalized = { title: requiredString(input.title, "title"), content: requiredString(input.content, "content"), sourceNodeIds: stringArray(input.sourceNodeIds) };
      break;
    case "update_text_node": {
      const title = optionalString(input.title);
      const content = optionalString(input.content);
      if (!title && !content) throw new Error("update_text_node 缺少 title 或 content");
      normalized = { nodeId: requiredString(input.nodeId, "nodeId"), ...(title ? { title } : {}), ...(content ? { content } : {}) };
      break;
    }
    case "update_node":
      normalized = { nodeId: requiredString(input.nodeId, "nodeId"), title: requiredString(input.title, "title") };
      break;
    case "set_agent_state": {
      const phase = requiredString(input.phase, "phase") as CanvasAgentPhase;
      if (!PHASES.includes(phase)) throw new Error("无效的 Agent 创作阶段");
      normalized = { phase, ...(optionalString(input.brief) ? { brief: optionalString(input.brief) } : {}), ...(positiveNumber(input.targetDurationSeconds) ? { targetDurationSeconds: positiveNumber(input.targetDurationSeconds) } : {}), ...(optionalString(input.approvedPlan) ? { approvedPlan: optionalString(input.approvedPlan) } : {}), ...(Array.isArray(input.approvedNodeIds) ? { approvedNodeIds: stringArray(input.approvedNodeIds) } : {}), ...(Array.isArray(input.referenceNodeIds) ? { referenceNodeIds: stringArray(input.referenceNodeIds) } : {}) };
      break;
    }
    case "create_group": {
      const nodeIds = stringArray(input.nodeIds);
      if (nodeIds.length < 2) throw new Error("create_group 至少需要两个节点");
      normalized = { nodeIds, ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}) };
      break;
    }
    case "list_workflows":
      normalized = optionalString(input.keyword) ? { keyword: optionalString(input.keyword) } : {};
      break;
    case "get_workflow":
      normalized = { workflowId: requiredString(input.workflowId, "workflowId") };
      break;
    case "save_workflow": {
      const variables = Array.isArray(input.variables) ? input.variables.map((item) => {
        if (!isRecord(item)) throw new Error("variables 必须是对象数组");
        return {
          key: requiredString(item.key, "variables.key"),
          label: requiredString(item.label, "variables.label"),
          required: item.required === true,
          ...(optionalString(item.defaultValue) ? { defaultValue: optionalString(item.defaultValue) } : {}),
        };
      }) : [];
      normalized = {
        ...(optionalString(input.workflowId) ? { workflowId: optionalString(input.workflowId) } : {}),
        ...(input.revision !== undefined ? { revision: boundedInteger(input.revision, 0, Number.MAX_SAFE_INTEGER) } : {}),
        ...(optionalString(input.description) ? { description: optionalString(input.description) } : {}),
        name: requiredString(input.name, "name"),
        promptTemplate: requiredString(input.promptTemplate, "promptTemplate"),
        variables,
        mode: requiredString(input.mode, "mode"),
      };
      break;
    }
    case "run_saved_workflow": {
      if (!Array.isArray(input.items) || input.items.length < 1) throw new Error("items 至少需要一项");
      const items = input.items.map((item) => {
        if (!isRecord(item)) throw new Error("items 必须是对象数组");
        const values = Array.isArray(item.values) ? item.values.map((value) => {
          if (!isRecord(value)) throw new Error("values 必须是对象数组");
          return { key: requiredString(value.key, "values.key"), value: typeof value.value === "string" ? value.value : String(value.value ?? "") };
        }) : [];
        return {
          ...(optionalString(item.title) ? { title: optionalString(item.title) } : {}),
          values,
          size: requiredString(item.size, "items.size"),
          count: boundedInteger(item.count, 1, 15),
          sourceNodeIds: stringArray(item.sourceNodeIds),
          attachmentIds: stringArray(item.attachmentIds),
        };
      });
      normalized = { workflowId: requiredString(input.workflowId, "workflowId"), items };
      break;
    }
    case "create_canvas_workflow": {
      if (!Array.isArray(input.steps) || input.steps.length < 1) throw new Error("steps 至少需要一步");
      const steps = input.steps.map((step) => {
        if (!isRecord(step)) throw new Error("steps 必须是对象数组");
        const type = requiredString(step.type, "steps.type");
        if (!["text", "image", "video", "audio"].includes(type)) throw new Error("steps.type 不是允许的值");
        return {
          key: requiredString(step.key, "steps.key"), type,
          title: requiredString(step.title, "steps.title"), prompt: requiredString(step.prompt, "steps.prompt"),
          dependsOn: stringArray(step.dependsOn), sourceNodeIds: stringArray(step.sourceNodeIds), attachmentIds: stringArray(step.attachmentIds),
          ...(optionalString(step.size) ? { size: optionalString(step.size) } : {}),
          ...(boundedInteger(step.count, 1, 15) !== undefined ? { count: boundedInteger(step.count, 1, 15) } : {}),
          ...(boundedInteger(step.seconds, 1, Number.MAX_SAFE_INTEGER) !== undefined ? { seconds: boundedInteger(step.seconds, 1, Number.MAX_SAFE_INTEGER) } : {}),
          ...(typeof step.generateAudio === "boolean" ? { generateAudio: step.generateAudio } : {}),
          ...(optionalString(step.voice) ? { voice: optionalString(step.voice) } : {}),
          ...(optionalString(step.resolution) ? { resolution: optionalString(step.resolution) } : {}),
        };
      });
      normalized = { steps, ...(optionalString(input.groupTitle) ? { groupTitle: optionalString(input.groupTitle) } : {}) };
      break;
    }
    case "run_canvas_workflow": {
      const nodeIds = stringArray(input.nodeIds);
      if (!nodeIds.length) throw new Error("nodeIds 至少需要一个节点");
      normalized = { nodeIds };
      break;
    }
    case "arrange_nodes":
      normalized = { nodeIds: stringArray(input.nodeIds) };
      break;
    case "generate_image":
    case "edit_image": {
      const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
      const attachmentIds = optionalStringArray(input.attachmentIds, "attachmentIds");
      normalized = { ...(attachmentIds ? { attachmentIds } : {}), prompt: requiredString(input.prompt, "prompt"), ...(sourceNodeIds ? { sourceNodeIds } : {}), ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}), ...(optionalString(input.size) ? { size: optionalString(input.size) } : {}), ...(optionalString(input.quality) ? { quality: optionalString(input.quality) } : {}), ...(optionalString(input.resolution) ? { resolution: optionalString(input.resolution) } : {}), ...(boundedInteger(input.count, 1, 15) ? { count: boundedInteger(input.count, 1, 15) } : {}) };
      if (actionName === "edit_image" && sourceNodeIds && !sourceNodeIds.length && !attachmentIds?.length) throw new Error("edit_image 缺少图片来源节点");
      break;
    }
    case "generate_video": {
      const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
      const attachmentIds = optionalStringArray(input.attachmentIds, "attachmentIds");
      normalized = { ...(attachmentIds ? { attachmentIds } : {}), prompt: requiredString(input.prompt, "prompt"), ...(sourceNodeIds ? { sourceNodeIds } : {}), ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}), ...(optionalString(input.size) ? { size: optionalString(input.size) } : {}), ...(optionalString(input.resolution) ? { resolution: optionalString(input.resolution) } : {}), ...(boundedNumber(input.seconds, 1, Number.MAX_SAFE_INTEGER) !== undefined ? { seconds: boundedNumber(input.seconds, 1, Number.MAX_SAFE_INTEGER) } : {}), ...(typeof input.generateAudio === "boolean" ? { generateAudio: input.generateAudio } : {}) };
      break;
    }
    case "generate_audio": {
      const sourceNodeIds = optionalStringArray(input.sourceNodeIds, "sourceNodeIds");
      normalized = { prompt: requiredString(input.prompt, "prompt"), ...(sourceNodeIds ? { sourceNodeIds } : {}), ...(optionalString(input.title) ? { title: optionalString(input.title) } : {}), ...(optionalString(input.voice) ? { voice: optionalString(input.voice) } : {}), ...(optionalString(input.instructions) ? { instructions: optionalString(input.instructions) } : {}) };
      break;
    }
  }
  return { id, name: actionName, arguments: normalized };
}

export function canvasAgentActionLabel(action: CanvasAgentAction) {
  const labels = actionLabels;
  return labels[action.name];
}

export function isCanvasAgentMediaAction(action: CanvasAgentAction) {
  return action.name === "generate_image" || action.name === "edit_image" || action.name === "generate_video" || action.name === "generate_audio" || action.name === "generate_node";
}

export function userLikelyRequestedCanvasAction(text: string) {
  return /(?:创建|新增|插入|修改|更新|删除|连接|连线|分组|整理|生成|生图|视频|音频|配音|旁白|执行|拆成|拆分|放到画布|开始做)/i.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function optionalString(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function requiredString(value: unknown, key: string) { const result = optionalString(value); if (!result) throw new Error(`${key} 不能为空`); return result; }
function stringArray(value: unknown) { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 50) : []; }
function optionalStringArray(value: unknown, key: string) { if (value === undefined) return undefined; if (!Array.isArray(value)) throw new Error(`${key} 必须是字符串数组`); return stringArray(value); }
function positiveNumber(value: unknown) { const number = typeof value === "number" ? value : Number(value); return Number.isFinite(number) && number > 0 ? number : undefined; }
function boundedNumber(value: unknown, minimum: number, maximum: number) { if (value === undefined || value === null || value === "") return undefined; const number = typeof value === "number" ? value : Number(value); if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`数值必须在 ${minimum} 到 ${maximum} 之间`); return number; }
function boundedInteger(value: unknown, minimum: number, maximum: number) { const number = boundedNumber(value, minimum, maximum); return number === undefined ? undefined : Math.floor(number); }

type ArgumentRule = {
  type: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  items?: ArgumentRule;
  properties?: Record<string, ArgumentRule>;
  required?: string[];
};

export function validateCanvasAgentArguments(args: Record<string, unknown>, schema: CanvasAgentToolDefinition["function"]["parameters"]) {
  validateArgument(args, schema as ArgumentRule, "arguments");
}

function validateArgument(value: unknown, rule: ArgumentRule, path: string) {
  if (rule.type === "object") {
    if (!isRecord(value)) throw new Error(`${path} 必须是 JSON 对象`);
    for (const key of rule.required || []) if (!(key in value)) throw new Error(`缺少工具参数 ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const child = rule.properties?.[key];
      if (!child) throw new Error(`未知工具参数 ${key}`);
      validateArgument(item, child, `${path}.${key}`);
    }
  } else if (rule.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
    if ((rule.minItems !== undefined && value.length < rule.minItems) || (rule.maxItems !== undefined && value.length > rule.maxItems)) throw new Error(`${path} 数量超出允许范围`);
    value.forEach((item, index) => {
      if (typeof item === "string" && !item.trim()) throw new Error(`${path} 必须是非空字符串组成的数组`);
      validateArgument(item, rule.items!, `${path}[${index}]`);
    });
  } else if (rule.type === "number" || rule.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (rule.type === "integer" && !Number.isInteger(value))) throw new Error(`${path} 必须是${rule.type === "integer" ? "整数" : "数字"}`);
    if ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)) throw new Error(`${path} 超出允许范围`);
  } else {
    if (typeof value !== rule.type) throw new Error(`${path} 类型错误，应为 ${rule.type}`);
    if (typeof value === "string" && rule.maxLength !== undefined && value.length > rule.maxLength) throw new Error(`${path} 最多 ${rule.maxLength} 字符`);
  }
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path} 不是允许的值`);
}
