import { httpRequest } from "@/lib/request";
import type { CustomRelayConfigsResponse } from "@/lib/api";

export async function isAutoDLRelay(tokenName: string, signal?: AbortSignal) {
  if (!tokenName.startsWith("__custom_relay__:")) return false;
  const { configs } = await httpRequest<CustomRelayConfigsResponse>("/api/profile/custom-relay-configs", { signal });
  return configs.find((item) => item.token_name === tokenName)?.protocol === "autodl";
}

export type AutoDLInputRule = {
  type: string;
  required: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  options?: Array<{ label: string }>;
};

export type AutoDLWorkflow = {
  uuid: string;
  name: string;
  kind: "audio" | "video" | "unknown";
  input_rules?: Record<string, AutoDLInputRule>;
};

export function fetchAutoDLWorkflows(tokenName: string, workflowID = "", signal?: AbortSignal) {
  const query = new URLSearchParams({ token_name: tokenName });
  if (workflowID) query.set("workflow_id", workflowID);
  return httpRequest<{ items: AutoDLWorkflow[] }>(`/api/profile/autodl-workflows?${query}`, { signal });
}
