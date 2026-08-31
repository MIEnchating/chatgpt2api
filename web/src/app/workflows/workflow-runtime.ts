import type { ImageGenerationPreferences, ModelConfig } from "@/lib/api";
import type {
  CreativeWorkflow,
  WorkflowGenerationConfig,
  WorkflowSeriesConfig,
  WorkflowVariable,
} from "@/services/api/workflows";

export type WorkflowSeriesDraft = {
  id: string;
  title: string;
  prompt: string;
  status: "draft" | "running" | "success" | "failed";
  error?: string;
  result_ids?: string[];
};

export type WorkflowGenerationDefaults = Partial<Pick<
  WorkflowGenerationConfig,
  "image_model" | "model" | "quality" | "size" | "count"
>> & {
  text_model?: string;
  text_channel_id?: string;
};

export function workflowGenerationDefaultsFromPreferences(
  preferences: ImageGenerationPreferences | undefined,
): WorkflowGenerationDefaults {
  if (!preferences) return {};
  const imageModel = preferences.default_image_model.trim();
  const workbench = preferences.workbench;
  return {
    ...(imageModel ? { image_model: imageModel, model: imageModel } : {}),
    quality: workbench.image_quality || "auto",
    size: workbench.image_size || "auto",
    count: String(Math.max(1, Math.min(10, Math.round(workbench.image_count || 1)))),
  };
}

function workflowTimestamp(value: string | undefined) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mergeWorkflowRunMetadata(
  workflow: CreativeWorkflow,
  metadata: Pick<CreativeWorkflow, "last_run_at" | "updated_at">,
): CreativeWorkflow {
  const lastRunAt = workflowTimestamp(metadata.last_run_at) > workflowTimestamp(workflow.last_run_at)
    ? metadata.last_run_at
    : workflow.last_run_at;
  const updatedAt = workflowTimestamp(metadata.updated_at) > workflowTimestamp(workflow.updated_at)
    ? metadata.updated_at
    : workflow.updated_at;
  return {
    ...workflow,
    last_run_at: lastRunAt,
    updated_at: updatedAt,
  };
}

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createWorkflowVariable(
  key = "",
  label = "",
  type: WorkflowVariable["type"] = "text",
): WorkflowVariable {
  return {
    id: uid(),
    key,
    label,
    type,
    required: true,
    default_value: "",
    options: [],
  };
}

function createWorkflowConfig(
  models: ModelConfig | null,
  preferences?: ImageGenerationPreferences,
  defaults: WorkflowGenerationDefaults = {},
): WorkflowGenerationConfig {
  const imageModel =
    defaults.image_model || defaults.model || preferences?.default_image_model || models?.default_image_model || "";
  return {
    model: imageModel,
    image_model: imageModel,
    quality: defaults.quality || "auto",
    size: defaults.size || "auto",
    count: defaults.count || "1",
    api_mode: preferences?.api_mode || "images",
    timeout: "600",
    system_prompt: preferences?.system_prompt || "",
    prompt_template: "",
    negative_prompt: "",
  };
}

function createWorkflowSeriesConfig(
  models: ModelConfig | null,
  preferences?: ImageGenerationPreferences,
  defaults: WorkflowGenerationDefaults = {},
): WorkflowSeriesConfig {
  return {
    target_count: "4",
    prompt_model:
      defaults.text_model || preferences?.default_text_model || models?.default_text_model || "",
    prompt_channel_id: defaults.text_channel_id || "",
    prompt_instruction:
      "围绕同一主题拆分成封面图、核心信息图、场景图和总结图；每张图需要画面重点不同但视觉风格一致。",
    review_required: true,
    concurrency: "3",
  };
}

export function createBlankWorkflow(
  models: ModelConfig | null,
  preferences: ImageGenerationPreferences | undefined,
  mode: CreativeWorkflow["mode"] = "single_image",
  defaults: WorkflowGenerationDefaults = {},
): CreativeWorkflow {
  const series = mode === "multi_image_series";
  return normalizeWorkflow({
    id: "",
    scope: "private",
    mode,
    name: series ? "多图系列生成" : "",
    category: series ? "多图创作" : "",
    description: series
      ? "根据主题生成一组连贯图片提示词，审核后批量生成图片。"
      : "",
    variables: series
      ? [
          createWorkflowVariable("topic", "主题", "textarea"),
          createWorkflowVariable("style", "统一风格"),
          createWorkflowVariable("platform", "发布平台"),
        ]
      : [
          createWorkflowVariable("product_name", "产品名称"),
          createWorkflowVariable("selling_points", "产品卖点", "textarea"),
        ],
    config: {
      ...createWorkflowConfig(models, preferences, defaults),
      ...(series
        ? {
            count: "1",
            prompt_template:
              "围绕 {{topic}} 生成一组适合 {{platform}} 发布的连贯配图。\n统一风格：{{style}}\n要求：主题一致、画面重点各不相同、适合连续发布。",
          }
        : {}),
    },
    series_config: createWorkflowSeriesConfig(models, preferences, defaults),
  });
}

export function createStarterWorkflows(
  models: ModelConfig | null,
  preferences?: ImageGenerationPreferences,
  defaults: WorkflowGenerationDefaults = {},
) {
  const poster = createBlankWorkflow(models, preferences, "single_image", defaults);
  poster.scope = "public";
  poster.name = "电商海报生成";
  poster.category = "电商海报";
  poster.description =
    "固定海报构图、商业摄影质感和营销文案结构，只替换产品与卖点。";
  poster.variables = [
    createWorkflowVariable("product_name", "产品名称"),
    createWorkflowVariable("selling_points", "核心卖点", "textarea"),
    createWorkflowVariable("campaign", "活动信息"),
  ];
  poster.config.prompt_template =
    "为 {{product_name}} 生成一张高端电商海报。\n核心卖点：{{selling_points}}\n活动信息：{{campaign}}\n要求：主体清晰、构图高级、商品有强烈质感，画面适合社交媒体和电商首图。";

  const series = createBlankWorkflow(
    models,
    preferences,
    "multi_image_series",
    defaults,
  );
  series.scope = "public";
  series.name = "小红书文章配图组";
  series.category = "多图创作";
  series.description =
    "根据文章主题和内容生成多张风格统一的封面、步骤、要点和总结配图。";
  series.variables = [
    createWorkflowVariable("article_topic", "文章主题"),
    createWorkflowVariable("article_content", "文章内容", "textarea"),
    createWorkflowVariable("visual_style", "视觉风格"),
  ];
  series.config.prompt_template =
    "为小红书/公众号文章《{{article_topic}}》生成系列配图。\n文章内容：{{article_content}}\n视觉风格：{{visual_style}}\n要求：画面适合移动端阅读，主题连贯，每张图表达一个清晰信息点。";
  series.series_config = {
    ...series.series_config,
    target_count: "6",
    prompt_instruction:
      "拆成封面图、问题/痛点图、核心步骤图、细节说明图、对比/案例图和总结图；每张图都需要独立完整的图片提示词。",
    concurrency: "3",
  };
  return [poster, series];
}

export function normalizeWorkflow(
  workflow: CreativeWorkflow,
  models: ModelConfig | null = null,
  preferences?: ImageGenerationPreferences,
  defaults: WorkflowGenerationDefaults = {},
): CreativeWorkflow {
  const fallbackConfig = createWorkflowConfig(models, preferences, defaults);
  const {
    image_channel_id: _legacyImageChannelID,
    stream_images: _legacyStreamImages,
    stream_partial_images: _legacyStreamPartialImages,
    response_format_b64_json: _legacyResponseFormat,
    codex_cli: _legacyCodexCLI,
    ...workflowConfig
  } = (workflow.config || {}) as WorkflowGenerationConfig & Record<string, unknown>;
  const config = {
    ...fallbackConfig,
    ...workflowConfig,
  };
  const seriesConfig = {
    ...createWorkflowSeriesConfig(models, preferences, defaults),
    ...workflow.series_config,
  };
  return {
    ...workflow,
    id: workflow.id || "",
    scope: workflow.scope === "public" ? "public" : "private",
    mode:
      workflow.mode === "multi_image_series"
        ? "multi_image_series"
        : "single_image",
    category: workflow.category || "",
    description: workflow.description || "",
    variables: (workflow.variables || []).map((variable) => ({
      ...createWorkflowVariable(),
      ...variable,
      id: variable.id || uid(),
      key: String(variable.key || "").replace(/[^\w.-]/g, "_"),
      label: variable.label || variable.key,
      default_value: String(variable.default_value ?? ""),
      options: Array.isArray(variable.options) ? variable.options : [],
    })),
    config,
    series_config: seriesConfig,
  };
}

export function createDefaultInputValues(workflow: CreativeWorkflow) {
  return Object.fromEntries(
    workflow.variables.map((variable) => [
      variable.key,
      variable.default_value || (variable.type === "boolean" ? "false" : ""),
    ]),
  );
}

export function resolveWorkflowRuntime(
  workflow: CreativeWorkflow,
  models: ModelConfig | null,
  preferences: ImageGenerationPreferences,
) {
  const preferredModel =
    workflow.config.image_model ||
    workflow.config.model ||
    preferences.default_image_model ||
    models?.default_image_model ||
    "";
  const model = models?.image_models.length && !models.image_models.includes(preferredModel)
    ? models.default_image_model || models.image_models[0] || ""
    : preferredModel;
  const count = Math.max(1, Math.min(10, Math.round(Number(workflow.config.count) || 1)));
  const timeout = Math.max(1, Math.min(3600, Math.round(Number(workflow.config.timeout) || 600)));
  return {
    model,
    api_mode: workflow.config.api_mode,
    system_prompt: workflow.config.system_prompt || preferences.system_prompt,
    quality: workflow.config.quality || "auto",
    size: workflow.config.size || "auto",
    count,
    timeout,
  };
}

export function renderWorkflowPrompt(
  workflow: CreativeWorkflow,
  values: Record<string, string>,
) {
  const formatted = Object.fromEntries(
    (workflow.variables || []).map((variable) => {
      const value = values[variable.key] ?? variable.default_value ?? "";
      return [
        variable.key,
        variable.type === "boolean" ? (value === "true" ? "开启" : "关闭") : value,
      ];
    }),
  );
  const prompt = String(workflow.config?.prompt_template || "")
    .replace(/{{\s*([\w.-]+)\s*}}/g, (_match, key: string) => formatted[key] || "")
    .trim();
  const negativePrompt = String(workflow.config?.negative_prompt || "").trim();
  return negativePrompt ? `${prompt}\n\n避免：${negativePrompt}` : prompt;
}

export function buildSeriesPromptDraftRequest(
  workflow: CreativeWorkflow,
  basePrompt: string,
  count: number,
  values: Record<string, string>,
) {
  const variables = Object.entries(values)
    .filter(([, value]) => String(value).trim())
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  return [
    "你是多图创作策划助手。请基于工作流信息，为同一主题生成一组互相连贯但画面重点不同的图片生成提示词。",
    '必须只返回 JSON，不要 Markdown。JSON 结构为：{"items":[{"title":"第1张标题","prompt":"完整图片提示词"}]}。',
    `目标张数：${count}`,
    `工作流名称：${workflow.name}`,
    `工作流分类：${workflow.category || "未分类"}`,
    `工作流描述：${workflow.description || "无"}`,
    workflow.series_config.prompt_instruction
      ? `系列拆分规则：${workflow.series_config.prompt_instruction}`
      : "",
    variables ? `用户输入变量：\n${variables}` : "",
    `基础提示词：\n${basePrompt}`,
    "要求：每条 prompt 必须可以独立用于图片生成；保持统一主题、统一风格和连续叙事；避免重复构图；不要包含解释文字。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractJSONText(content: string) {
  const trimmed = content
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart)
    return trimmed.slice(objectStart, objectEnd + 1);
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  return arrayStart >= 0 && arrayEnd > arrayStart
    ? trimmed.slice(arrayStart, arrayEnd + 1)
    : "";
}

export function parseWorkflowSeriesDrafts(
  content: string,
  targetCount: number,
  fallbackPrompt = "",
): WorkflowSeriesDraft[] {
  const count = Math.max(1, Math.min(20, Math.round(targetCount) || 4));
  const jsonText = extractJSONText(content);
  if (jsonText) {
    try {
      const payload = JSON.parse(jsonText) as
        | { items?: Array<{ title?: string; prompt?: string }> }
        | Array<{ title?: string; prompt?: string }>;
      const items = Array.isArray(payload) ? payload : payload.items || [];
      const drafts = items
        .map((item, index) => ({
          id: uid(),
          title: item.title?.trim() || `第 ${index + 1} 张`,
          prompt: item.prompt?.trim() || "",
          status: "draft" as const,
        }))
        .filter((item) => item.prompt);
      if (drafts.length) return drafts.slice(0, count);
    } catch {
      // Keep the reference project's line and fallback parsing behavior.
    }
  }
  const lines = content
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, count);
  if (lines.length) {
    return lines.map((line, index) => ({
      id: uid(),
      title: `第 ${index + 1} 张`,
      prompt: line,
      status: "draft" as const,
    }));
  }
  return Array.from({ length: count }, (_, index) => ({
    id: uid(),
    title: `第 ${index + 1} 张`,
    prompt: `${fallbackPrompt}\n\n系列图片：第 ${index + 1} 张，画面重点与其他图片保持差异。`,
    status: "draft" as const,
  }));
}

export function normalizeSeriesDraft(draft: WorkflowSeriesDraft) {
  return {
    id: draft.id || uid(),
    title: draft.title || "未命名",
    prompt: draft.prompt || "",
    status: draft.status === "running" ? ("draft" as const) : draft.status || "draft",
    error: draft.error,
    result_ids: Array.isArray(draft.result_ids) ? draft.result_ids : [],
  };
}

export function parseVariableOptions(text: string) {
  return text
    .split(/[/\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
