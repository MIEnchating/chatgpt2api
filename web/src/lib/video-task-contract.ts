import type { ManagedVideoModelContract } from "./api";
import { matchVideoModelContract } from "./video-model-contracts";

export type VideoTaskContractReference = {
  id?: string;
  name: string;
  driver: string;
  revision?: number;
};

export function videoTaskContractReferencesEqual(left?: VideoTaskContractReference, right?: VideoTaskContractReference) {
  return left?.id === right?.id && left?.name === right?.name && left?.driver === right?.driver && left?.revision === right?.revision;
}

export function normalizeVideoTaskContractReference(value: unknown): VideoTaskContractReference | undefined {
  if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string" || !value.name.trim()) return undefined;
  const source = value as Record<string, unknown>;
  return {
    name: value.name.trim(),
    driver: typeof source.driver === "string" ? source.driver.trim() : "",
    id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : undefined,
    revision: Number.isSafeInteger(source.revision) && Number(source.revision) > 0 ? Number(source.revision) : undefined,
  };
}

export function resolveVideoTaskContracts(items: ManagedVideoModelContract[], model: string, used?: VideoTaskContractReference) {
  const active = items.filter((item) => item.enabled);
  const matched = matchVideoModelContract(active.map((item) => item.contract), model);
  return {
    used: used?.id ? items.find((item) => item.id === used.id) : undefined,
    current: matched ? active.find((item) => item.contract.name === matched.name) : undefined,
  };
}
