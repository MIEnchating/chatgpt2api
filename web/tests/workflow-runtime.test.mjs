import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeriesPromptDraftRequest,
  createBlankWorkflow,
  createDefaultInputValues,
  normalizeSeriesDraft,
  normalizeWorkflow,
  parseVariableOptions,
  parseWorkflowSeriesDrafts,
  renderWorkflowPrompt,
  resolveWorkflowRuntime,
  workflowGenerationDefaultsFromPreferences,
} from "../src/app/workflows/workflow-runtime.ts";
import {
  restoreWorkflowTasks,
  workflowTaskFailureEvent,
  workflowTaskStartEvent,
} from "../src/app/workflows/workflow-task-runtime.ts";

const models = {
  image_models: ["gpt-image-1.5", "gemini-3-pro-image-preview"],
  default_image_model: "gpt-image-1.5",
  video_models: [],
  default_video_model: "",
  text_models: ["gpt-5.2"],
  default_text_model: "gpt-5.2",
  audio_models: [],
  default_audio_model: "",
  relay_base_url: "",
};

const preferences = {
  stream: true,
  partial_images: 2,
  response_format_b64_json: true,
  codex_cli_compatibility: false,
  system_prompt: "保持视觉一致",
  video_system_prompt: "",
  audio_instructions: "",
  default_text_model: "gpt-5.2",
  default_image_model: "gpt-image-1.5",
  default_video_model: "",
  default_audio_model: "",
  workbench: {
    image_size: "2048x1152",
    image_size_mode: "ratio",
    image_aspect_ratio: "16:9",
    image_resolution: "2k",
    image_custom_ratio: "16:9",
    image_custom_width: "2048",
    image_custom_height: "1152",
    image_snap_to_multiple_16: true,
    image_quality: "high",
    image_count: 3,
    image_output_format: "png",
    image_output_compression: "",
    video_size: "1280x720",
    video_seconds: "6",
    video_resolution: "720p",
    video_mode: "std",
    video_generate_audio: false,
    video_watermark: false,
  },
};

test("workflow defaults come from account workbench preferences", () => {
  assert.deepEqual(workflowGenerationDefaultsFromPreferences(preferences), {
    image_model: "gpt-image-1.5",
    model: "gpt-image-1.5",
    quality: "high",
    size: "2048x1152",
    count: "3",
  });
});

test("blank workflow uses the complete reference generation contract", () => {
  const workflow = createBlankWorkflow(models, preferences);
  assert.equal(workflow.mode, "single_image");
  assert.deepEqual(Object.keys(workflow.config).sort(), [
    "api_mode",
    "count",
    "image_model",
    "model",
    "negative_prompt",
    "prompt_template",
    "quality",
    "size",
    "system_prompt",
    "timeout",
  ]);
  assert.equal(workflow.config.system_prompt, "保持视觉一致");
  assert.equal(workflow.config.quality, "auto");
});

test("new workflow inherits image settings but keeps the personal API mode", () => {
  const workflow = createBlankWorkflow(models, { ...preferences, api_mode: "images" }, "single_image", {
    image_model: "gemini-3-pro-image-preview",
    text_model: "gpt-5.2",
    text_channel_id: "current-text-token",
    api_mode: "responses",
    quality: "high",
    size: "2048x1152",
    count: "3",
  });
  assert.equal(workflow.config.image_model, "gemini-3-pro-image-preview");
  assert.equal(workflow.config.model, "gemini-3-pro-image-preview");
  assert.equal(workflow.config.api_mode, "images");
  assert.equal(workflow.config.quality, "high");
  assert.equal(workflow.config.size, "2048x1152");
  assert.equal(workflow.config.count, "3");
  assert.equal(workflow.series_config.prompt_model, "gpt-5.2");
  assert.equal(workflow.series_config.prompt_channel_id, "current-text-token");
});

test("multi-image workflow contains reference planning parameters", () => {
  const workflow = createBlankWorkflow(models, preferences, "multi_image_series");
  assert.equal(workflow.series_config.target_count, "4");
  assert.equal(workflow.series_config.prompt_model, "gpt-5.2");
  assert.equal(workflow.series_config.review_required, true);
  assert.equal(workflow.series_config.concurrency, "3");
  assert.match(workflow.series_config.prompt_instruction, /封面图/);
});

test("prompt rendering formats all variable types and appends negative prompt", () => {
  const workflow = createBlankWorkflow(models, preferences);
  workflow.variables = [
    { id: "name", key: "name", label: "名称", type: "text", required: true, default_value: "默认产品", options: [] },
    { id: "enabled", key: "enabled", label: "启用", type: "boolean", required: false, default_value: "false", options: [] },
  ];
  workflow.config.prompt_template = "为 {{ name }} 生成海报，功能：{{enabled}}";
  workflow.config.negative_prompt = "模糊，水印";
  assert.deepEqual(createDefaultInputValues(workflow), { name: "默认产品", enabled: "false" });
  assert.equal(
    renderWorkflowPrompt(workflow, { name: "旅行背包", enabled: "true" }),
    "为 旅行背包 生成海报，功能：开启\n\n避免：模糊，水印",
  );
});

test("normalization ignores removed DAG fields", () => {
  const workflow = normalizeWorkflow({
    id: "current",
    scope: "private",
    mode: "dag",
    name: "当前工作流",
    category: "",
    description: "",
    variables: [{ key: "subject", label: "主题", type: "text", required: true, default: "海岛" }],
    steps: [{ id: "poster", name: "海报", type: "image", prompt: "{{subject}} 海报", model: "gpt-image-1.5", config: { size: "1536x1024", quality: "high", count: 3 } }],
  }, models, preferences);
  assert.equal(workflow.mode, "single_image");
  assert.equal(workflow.config.prompt_template, "");
  assert.equal(workflow.config.size, "auto");
  assert.equal(workflow.config.count, "1");
  assert.equal(workflow.variables[0].default_value, "");
});

test("series request carries workflow metadata, variables, rules, and base prompt", () => {
  const workflow = createBlankWorkflow(models, preferences, "multi_image_series");
  workflow.name = "文章配图";
  workflow.category = "内容创作";
  const request = buildSeriesPromptDraftRequest(
    workflow,
    "为咖啡教程生成配图",
    6,
    { topic: "手冲咖啡", style: "极简" },
  );
  assert.match(request, /目标张数：6/);
  assert.match(request, /工作流名称：文章配图/);
  assert.match(request, /系列拆分规则/);
  assert.match(request, /- topic: 手冲咖啡/);
  assert.match(request, /为咖啡教程生成配图/);
});

test("series parser accepts fenced JSON and follows reference fallbacks", () => {
  const drafts = parseWorkflowSeriesDrafts(
    '```json\n{"items":[{"title":"封面","prompt":"主视觉"},{"prompt":"细节"},{"prompt":"忽略"}]}\n```',
    2,
    "基础提示词",
  );
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].title, "封面");
  assert.equal(drafts[1].title, "第 2 张");
  assert.equal(drafts[1].status, "draft");

  const fallback = parseWorkflowSeriesDrafts("", 3, "基础提示词");
  assert.equal(fallback.length, 3);
  assert.match(fallback[2].prompt, /第 3 张/);
  assert.equal(normalizeSeriesDraft({ ...fallback[0], status: "running" }).status, "draft");
});

test("select variable options match the reference separators", () => {
  assert.deepEqual(parseVariableOptions("自动 / 极简\n商业,清冷，温暖"), [
    "自动",
    "极简",
    "商业,清冷，温暖",
  ]);
});

test("workflow creation tasks restore as one ordered image batch", () => {
  const context = {
    workflow_id: "workflow-1",
    workflow_name: "商品海报",
    prompt: "生成两张商品海报",
    inputs: { product: "旅行背包" },
    references: [{ id: "ref-1", name: "参考图", url: "/api/files/ref/content", storageKey: "server:ref", temporary: true }],
    config: {
      model: "gpt-image-1.5",
      image_model: "gpt-image-1.5",
      quality: "high",
      size: "1024x1024",
      count: "1",
      api_mode: "responses",
      timeout: "600",
      prompt_template: "{{product}}",
    },
    count: 1,
    batch_task_id: "workflow-batch-1",
    batch_count: 2,
  };
  const restored = restoreWorkflowTasks([
    {
      id: "child-2",
      status: "running",
      mode: "generation",
      created_at: "2026-08-26T08:00:01Z",
      updated_at: "2026-08-26T08:00:02Z",
      model: "gpt-image-1.5",
      data: [],
      workflow_context: { ...context, batch_index: 2 },
    },
    {
      id: "child-1",
      status: "success",
      mode: "generation",
      created_at: "2026-08-26T08:00:00Z",
      updated_at: "2026-08-26T08:00:03Z",
      model: "gpt-image-1.5",
      data: [{ url: "/images/result.png", width: 1024, height: 1024, bytes: 2048 }],
      workflow_context: { ...context, batch_index: 1 },
    },
  ]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, "workflow-batch-1");
  assert.equal(restored[0].status, "running");
  assert.equal(restored[0].count, 2);
  assert.deepEqual(restored[0].backend_task_ids, ["child-1", "child-2"]);
  assert.deepEqual(restored[0].inputs, { product: "旅行背包" });
  assert.deepEqual(restored[0].references, [{
    id: "ref-1",
    name: "参考图",
    url: "/api/files/ref/content",
    storageKey: "server:ref",
    temporary: true,
  }]);
  assert.deepEqual(restored[0].images[0], {
    url: "/images/result.png",
    index: 0,
    width: 1024,
    height: 1024,
    bytes: 2048,
  });
});

test("workflow batch reports failure after all child tasks finish", () => {
  const base = {
    mode: "generation",
    created_at: "2026-08-26T08:00:00Z",
    updated_at: "2026-08-26T08:01:00Z",
    workflow_context: {
      workflow_id: "workflow-1",
      workflow_name: "商品海报",
      prompt: "生成海报",
      inputs: {},
      references: [],
      config: { quality: "auto", size: "auto", count: "1", api_mode: "images", timeout: "600", prompt_template: "生成海报" },
      count: 1,
      batch_task_id: "batch",
      batch_count: 2,
    },
  };
  const restored = restoreWorkflowTasks([
    { ...base, id: "success", status: "success", data: [{ b64_json: "AAAA", output_format: "webp" }], workflow_context: { ...base.workflow_context, batch_index: 1 } },
    { ...base, id: "failed", status: "error", error: "额度不足", data: [], workflow_context: { ...base.workflow_context, batch_index: 2 } },
  ]);
  assert.equal(restored[0].status, "failed");
  assert.equal(restored[0].error, "额度不足");
  assert.equal(restored[0].image_urls[0], "data:image/webp;base64,AAAA");
  assert.equal(restored[0].images[0].index, 0);
  const start = workflowTaskStartEvent(restored[0]);
  assert.equal(start.taskId, "batch");
  assert.equal(start.count, 2);
  const failure = workflowTaskFailureEvent(restored[0]);
  assert.equal(failure.images[0].index, 0);
  assert.equal(failure.images[0].mimeType, "image/webp");
});

test("workflow normalization removes legacy personal transport settings", () => {
  const source = createBlankWorkflow(models, preferences);
  const workflow = normalizeWorkflow({
    ...source,
    id: "flags",
    name: "Flags",
    config: {
      ...source.config,
      prompt_template: "test",
      stream_images: "false",
      response_format_b64_json: "true",
      codex_cli: "0",
    },
  }, models, preferences);

  assert.equal("stream_images" in workflow.config, false);
  assert.equal("response_format_b64_json" in workflow.config, false);
  assert.equal("codex_cli" in workflow.config, false);
});

test("workflow runtime uses the selected template's saved generation settings", () => {
  const source = createBlankWorkflow(models, { ...preferences, api_mode: "responses" });
  const configured = {
    ...source,
    config: {
      ...source.config,
      model: "gemini-3-pro-image-preview",
      image_model: "gemini-3-pro-image-preview",
      api_mode: "images",
      system_prompt: "",
      quality: "high",
      size: "2048x1152",
      count: "3",
      timeout: "900",
    },
  };
  assert.deepEqual(
    resolveWorkflowRuntime(
      configured,
      models,
      { ...preferences, api_mode: "responses" },
    ),
    {
      model: "gemini-3-pro-image-preview",
      api_mode: "images",
      system_prompt: "保持视觉一致",
      quality: "high",
      size: "2048x1152",
      count: 3,
      timeout: 900,
    },
  );
});

test("editing one workflow does not change another workflow's generation settings", () => {
  const first = createBlankWorkflow(models, preferences);
  const second = createBlankWorkflow(models, preferences);
  first.config = { ...first.config, quality: "high", size: "2048x1152", count: "3" };
  assert.equal(second.config.quality, "auto");
  assert.equal(second.config.size, "auto");
  assert.equal(second.config.count, "1");
});
