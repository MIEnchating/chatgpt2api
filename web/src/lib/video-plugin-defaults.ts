import type { VideoModelContract } from "./video-model-contracts";
import type { NewAPIVideoPluginOptions } from "./api";

export function videoPluginDefaults(contract: VideoModelContract) {
  const models = [...contract.models].sort();
  const identity = JSON.stringify([models, contract.driver, contract.transport.create_path, contract.transport.query_path]);
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const slug = (models[0] || "video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 15) || "video";
  let downloadMode: NewAPIVideoPluginOptions["download_mode"] | "" = "";
  if (contract.artifact.mode === "task_content" && contract.artifact.content_path) downloadMode = "task_content";
  if (contract.artifact.mode === "response_url" && contract.polling.result_fields.length) {
    downloadMode = contract.artifact.auth === "none" ? "signed_url" : "authenticated_url";
  }
  return {
    key: `video-${slug}-${(hash >>> 0).toString(16).padStart(8, "0")}`,
    version: "1.0.0",
    baseURL: contract.provider?.base_url || "",
    models: contract.models.join("\n"),
    authMode: contract.provider?.auth_mode || "" as const,
    authHeader: contract.provider?.auth_header || "",
    downloadMode,
    resultFields: contract.polling.result_fields.join("\n"),
  };
}
