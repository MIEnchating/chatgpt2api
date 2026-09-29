import { httpRequest } from "@/lib/request";
import type { CustomRelayConfigStatus } from "@/lib/api";

export type RunningHubField = {
  id: string;
  nodeId: string;
  fieldName: string;
  fieldType?: string;
  role?: string;
  enabled: boolean;
  required?: boolean;
};

export type RunningHubWorkflow = {
  provider: "runninghub";
  kind: "workflow" | "app";
  workflowId: string;
  title: string;
  capability: "image" | "video" | "audio";
  enabled: boolean;
  fields: RunningHubField[];
  workflowJson?: Record<string, unknown>;
};

export function fetchRunningHubWorkflow(
  tokenName: string,
  workflowID: string,
  capability: RunningHubWorkflow["capability"],
  kind: RunningHubWorkflow["kind"] = "workflow",
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ token_name: tokenName, workflow_id: workflowID, capability, kind });
  return httpRequest<{ items: RunningHubWorkflow[] }>(`/api/profile/runninghub-workflows?${query}`, { signal });
}

export function isRunningHubRelay(status: Pick<CustomRelayConfigStatus, "protocol">) {
  return status.protocol === "runninghub";
}
