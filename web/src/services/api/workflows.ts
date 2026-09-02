import { httpRequest } from "@/lib/request";

export type WorkflowVariable = {
  id: string;
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "number" | "boolean";
  required: boolean;
  default_value: string;
  placeholder?: string;
  options: string[];
};

export type WorkflowGenerationConfig = {
  model: string;
  image_model: string;
  quality: string;
  size: string;
  count: string;
  api_mode: "images" | "responses" | "chat";
  timeout: string;
  system_prompt: string;
  prompt_template: string;
  negative_prompt: string;
};

export type WorkflowExecutionSnapshot = {
  stream: boolean;
  partial_images: number;
  response_format_b64_json: boolean;
  codex_cli_compatibility: boolean;
  token_name?: string;
};

export type WorkflowSeriesConfig = {
  target_count: string;
  prompt_model: string;
  prompt_channel_id: string;
  prompt_instruction: string;
  review_required: boolean;
  concurrency: string;
};

export type CreativeWorkflow = {
  id: string;
  revision?: number;
  owner_id?: string;
  scope: "private" | "public";
  name: string;
  category: string;
  description: string;
  mode: "single_image" | "multi_image_series";
  variables: WorkflowVariable[];
  config: WorkflowGenerationConfig;
  series_config: WorkflowSeriesConfig;
  created_at?: string;
  updated_at?: string;
  last_run_at?: string;
  editable?: boolean;
};

export type WorkflowTaskContext = {
  workflow_id: string;
  workflow_name: string;
  prompt: string;
  inputs: Record<string, string>;
  references: Array<{
    id: string;
    name: string;
    url: string;
    storageKey?: string;
    temporary?: boolean;
  }>;
  config: WorkflowGenerationConfig;
  execution: WorkflowExecutionSnapshot;
  count: number;
  series_title?: string;
  series_index?: number;
  batch_task_id?: string;
  batch_index?: number;
  batch_count?: number;
};

export type WorkflowAgentDraftResponse = {
  draft: Partial<CreativeWorkflow>;
  warnings: string[];
  model: string;
};

export async function fetchWorkflows() {
  const response = await httpRequest<{ items?: CreativeWorkflow[] }>("/api/workflows");
  return Array.isArray(response.items) ? response.items : [];
}

export async function initializeWorkflows(items: CreativeWorkflow[]) {
  const response = await httpRequest<{ items?: CreativeWorkflow[] }>("/api/workflows/initialize", {
    method: "POST",
    body: { items },
  });
  return Array.isArray(response.items) ? response.items : [];
}

export async function saveWorkflow(workflow: CreativeWorkflow) {
  const response = await httpRequest<{ item: CreativeWorkflow }>("/api/workflows", {
    method: workflow.id ? "PUT" : "POST",
    body: workflow,
  });
  return response.item;
}

export async function touchWorkflowLastRun(id: string, lastRunAt: string) {
  const response = await httpRequest<{ item: CreativeWorkflow }>(
    `/api/workflows/${encodeURIComponent(id)}/last-run`,
    {
      method: "PUT",
      body: { last_run_at: lastRunAt },
    },
  );
  return response.item;
}

export async function deleteWorkflow(id: string) {
  await httpRequest<void>(`/api/workflows/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function draftWorkflowWithAgent(input: {
  prompt: string;
  scope: "private" | "public";
  model?: string;
  channelID?: string;
  references?: string[];
}, options: { signal: AbortSignal }) {
  return httpRequest<WorkflowAgentDraftResponse>("/api/workflows/agent-draft", {
    method: "POST",
    signal: options.signal,
    timeout: 610_000,
    body: {
      prompt: input.prompt,
      scope: input.scope,
      ...(input.model ? { model: input.model } : {}),
      ...(input.channelID ? { channel_id: input.channelID } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
    },
  });
}
