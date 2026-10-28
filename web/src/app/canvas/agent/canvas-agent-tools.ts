import { nanoid } from "nanoid";

import type { CanvasAgentPhase } from "./canvas-agent-types";

const CANVAS_AGENT_ACTION_NAMES = [
  "get_canvas_summary",
  "get_selected_nodes",
  "query_canvas_nodes",
  "read_skill_file",
  "get_node",
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

const STRING = { type: "string" };
const STRING_ARRAY = { type: "array", items: STRING, maxItems: 50 };
const PHASES: CanvasAgentPhase[] = ["intake", "concept", "script", "breakdown", "references", "storyboard", "video", "audio", "review", "complete"];
const ACTION_NAMES = new Set<string>(CANVAS_AGENT_ACTION_NAMES);

function tool(name: CanvasAgentActionName, description: string, parameters: Record<string, unknown> = {}, required?: string[]): CanvasAgentToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: parameters,
        required,
        additionalProperties: false,
      },
    },
  };
}

export const CANVAS_AGENT_SKILL_FILE_TOOL = tool("read_skill_file", "读取本轮所选 Skill 明确引用的附属文件。", { skillId: STRING, path: STRING }, ["skillId", "path"]);

export const CANVAS_AGENT_TOOLS: CanvasAgentToolDefinition[] = [
  tool("ask_user_question", "必要交付参数尚未由用户明确或委托决定时必须提问，不能用默认值代替确认；存在歧义或需用户确认时也使用此工具。调用后暂停，不得同批执行依赖答案的操作。已明确授权且信息足够时直接执行，不重复询问。", {
    question: { type: "string", maxLength: 500 }, reason: { type: "string", maxLength: 500 },
    options: { type: "array", description: "可比较的建议选项；第一项必须是 Agent 最推荐的方案，界面会标注推荐。没有合适选项时传空数组，让用户直接输入。用户始终可以自由输入或修改选项。", items: { type: "string", maxLength: 120 }, maxItems: 4 },
    kind: { type: "string", enum: ["clarification", "confirmation"] },
    purpose: { type: "string", enum: ["media_generation"], description: "只有在询问是否现在提交图片、视频或音频生成任务时设为 media_generation。" },
  }, ["question", "reason", "options", "kind"]),
  tool("update_plan", "保存复杂任务的简短执行计划与当前进度。简单请求无需计划。最多一个步骤进行中，完成状态必须依据实际工具结果；待生成任务不能标为完成。用户暂不生成时，将生成及依赖成品的步骤标为 deferred，继续其他步骤。", {
    explanation: { type: "string", maxLength: 500 },
    steps: { type: "array", minItems: 1, maxItems: 10, items: {
      type: "object", additionalProperties: false, required: ["id", "title", "status"], properties: {
        id: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 160 },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deferred"] },
      },
    } },
  }, ["explanation", "steps"]),
  tool("get_canvas_summary", "读取当前画布摘要、节点、连线、模型配置和任务状态。"),
  tool("query_canvas_nodes", "按 ID、标题、正文、提示词或类型分页查找全画布节点。", { nodeId: STRING, keyword: STRING, type: { type: "string", enum: ["image", "video", "audio", "panorama", "director", "group", "text", "config"] }, page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 50 } }),
  tool("get_selected_nodes", "读取用户当前选中的真实画布节点。"),
  tool("get_node", "按真实节点 ID 读取节点。", { nodeId: STRING }, ["nodeId"]),
  tool("get_upstream_nodes", "读取指定节点的所有直接上游节点。", { nodeId: STRING }, ["nodeId"]),
  tool("get_downstream_nodes", "读取指定节点的所有直接下游节点。", { nodeId: STRING }, ["nodeId"]),
  tool("get_connected_nodes", "读取指定节点直接连接的上下游节点。", { nodeId: STRING }, ["nodeId"]),
  tool("get_generation_config", "读取当前模型、支持的图片比例/画质和视频尺寸/清晰度/时长/声音能力，以及非关键技术参数的默认值。默认值不是用户要求，按创作目标为每次生成选择参数。"),
  tool("get_generation_task", "读取指定媒体节点的真实生成任务状态。", { nodeId: STRING }, ["nodeId"]),
  tool("set_agent_state", "保存当前创作阶段、已确认方案和正式参考，供刷新后继续。", { phase: { type: "string", enum: PHASES }, brief: STRING, targetDurationSeconds: { type: "number", minimum: 1 }, approvedPlan: STRING, approvedNodeIds: STRING_ARRAY, referenceNodeIds: STRING_ARRAY }, ["phase"]),
  tool("create_primary_script_node", "仅用于新创作流程首次创建正式主剧本或总制作稿，固定使用主剧本节点尺寸。", { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY, projectTitle: STRING }, ["title", "content", "projectTitle"]),
  tool("create_text_node", "创建镜头、角色、产品、场景、声音说明和其他普通文本节点；不得用于首次正式主剧本。", { title: STRING, content: STRING, sourceNodeIds: STRING_ARRAY }, ["title", "content"]),
  tool("update_text_node", "更新现有文本节点的标题或正文。", { nodeId: STRING, title: STRING, content: STRING }, ["nodeId"]),
  tool("update_node", "只更新现有节点标题；不允许任意字段覆盖。", { nodeId: STRING, title: STRING }, ["nodeId", "title"]),
  tool("delete_node", "使用画布现有删除链路删除节点及关联连线。", { nodeId: STRING }, ["nodeId"]),
  tool("create_connection", "在两个真实节点之间创建来源连线。", { fromNodeId: STRING, toNodeId: STRING }, ["fromNodeId", "toNodeId"]),
  tool("delete_connection", "删除指定真实连线。", { connectionId: STRING }, ["connectionId"]),
  tool("create_group", "把两个或更多节点放进本项目 group 节点。", { title: STRING, nodeIds: STRING_ARRAY }, ["nodeIds"]),
  tool("arrange_nodes", "整理指定节点；不传 nodeIds 时整理当前画布顶层节点。", { nodeIds: STRING_ARRAY }),
  tool("generate_image", "创建图片节点，size/count 须来自用户要求、已确认方案或明确委托；缺失时先 ask_user_question。并仅在自动生成开启时提交任务。sourceNodeIds 只放真实直接来源，attachmentIds 引用当前对话附件；独立生成时两者均传空数组，其中图片依次编号。", { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, attachmentIds: STRING_ARRAY, size: STRING, quality: { type: "string", enum: ["low", "medium", "high"] }, resolution: STRING, count: { type: "integer", minimum: 1, maximum: 15 } }, ["prompt", "sourceNodeIds", "size", "count"]),
  tool("edit_image", "创建图片编辑节点，size/count 须来自用户要求、已确认方案或明确委托；缺失时先 ask_user_question。并仅在自动生成开启时提交任务，必须通过 sourceNodeIds 或 attachmentIds 提供至少一个图片节点或消息附件；先按节点顺序、再按附件顺序编号。", { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, attachmentIds: STRING_ARRAY, size: STRING, quality: { type: "string", enum: ["low", "medium", "high"] }, resolution: STRING, count: { type: "integer", minimum: 1, maximum: 15 } }, ["prompt", "sourceNodeIds", "size", "count"]),
  tool("generate_video", "创建视频节点，size/seconds/generateAudio 须来自用户要求、已确认方案或明确委托；缺失时先 ask_user_question。并仅在自动生成开启时提交任务。sourceNodeIds 只放真实直接来源，attachmentIds 引用当前对话附件；独立生成时两者均传空数组，其中图片、视频、音频分别按各自顺序编号。", { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, attachmentIds: STRING_ARRAY, size: STRING, resolution: STRING, seconds: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, generateAudio: { type: "boolean" } }, ["prompt", "sourceNodeIds", "size", "seconds", "generateAudio"]),
  tool("generate_audio", "创建音频节点，并仅在自动生成开启时提交任务。prompt 是实际朗读文本，instructions 是音色/演绎说明；sourceNodeIds 只放真实直接来源，独立生成必须传空数组。", { prompt: STRING, title: STRING, sourceNodeIds: STRING_ARRAY, voice: STRING, instructions: STRING }, ["prompt", "sourceNodeIds"]),
  tool("get_media_task_status", "读取图片、视频或音频节点的生成状态。", { nodeId: STRING }, ["nodeId"]),
  tool("generate_node", "继续生成已有的图片、视频或音频节点，复用保存的提示词、参数和引用，不创建新节点。已完成时返回已有结果，生成中等待原任务；失败时原位重试。自动生成关闭时保留待手动生成状态。", { nodeId: STRING }, ["nodeId"]),
];

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
      normalized = { question: requiredString(input.question, "question"), reason: requiredString(input.reason, "reason"), options, kind: input.kind, ...(input.purpose === "media_generation" ? { purpose: "media_generation" } : {}) };
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
  const labels: Record<CanvasAgentActionName, string> = {
    generate_node: "正在继续节点生成",
    ask_user_question: "等待你补充信息", update_plan: "正在更新执行计划", query_canvas_nodes: "正在查找画布节点", read_skill_file: "正在读取 Skill 文件", get_canvas_summary: "正在读取画布", get_selected_nodes: "正在读取选中节点", get_node: "正在读取节点", get_upstream_nodes: "正在读取上游节点", get_downstream_nodes: "正在读取下游节点", get_connected_nodes: "正在读取关联节点", get_generation_config: "正在读取生成配置", get_generation_task: "正在读取任务状态", set_agent_state: "正在保存创作进度", create_primary_script_node: "正在创建主剧本节点", create_text_node: "正在创建文本节点", update_text_node: "正在更新文本节点", update_node: "正在更新节点", delete_node: "正在删除节点", create_connection: "正在创建连线", delete_connection: "正在删除连线", create_group: "正在创建分组", arrange_nodes: "正在整理画布", generate_image: "正在创建图片节点", edit_image: "正在创建图片编辑节点", generate_video: "正在创建视频节点", generate_audio: "正在创建音频节点", get_media_task_status: "正在读取媒体任务",
  };
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
