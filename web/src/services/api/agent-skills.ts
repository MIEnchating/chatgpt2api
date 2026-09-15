import { httpRequest } from "@/lib/request";

export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: "system" | "personal";
  enabled: boolean;
  revision: number;
  updated_at: string;
  file_paths?: string[];
  files?: Record<string, string>;
};

export type AgentSkillInput = Pick<AgentSkill, "name" | "description" | "content" | "enabled"> & {
  revision?: number;
  files?: Record<string, string>;
};

function skillRoot(system: boolean) {
  return system ? "/api/admin/agent-skills" : "/api/profile/agent-skills";
}

export async function fetchAgentSkills(system = false, signal?: AbortSignal) {
  return httpRequest<{ items: AgentSkill[] }>(skillRoot(system), { signal });
}

export async function saveAgentSkill(input: AgentSkillInput, id = "", system = false, signal?: AbortSignal) {
  return httpRequest<{ item: AgentSkill }>(`${skillRoot(system)}${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PUT" : "POST", body: input, signal,
  });
}

export async function deleteAgentSkill(skill: AgentSkill, signal?: AbortSignal) {
  return httpRequest<{ ok: boolean }>(`${skillRoot(skill.scope === "system")}/${encodeURIComponent(skill.id)}?revision=${skill.revision}`, {
    method: "DELETE", signal,
  });
}

export async function readAgentSkillFile(id: string, path: string, signal?: AbortSignal) {
  return httpRequest<{ path: string; content: string }>(`${skillRoot(false)}/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`, { signal });
}
