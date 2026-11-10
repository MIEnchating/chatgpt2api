import type { PlanStep } from "./plan";

export function planProgressLabel(steps: readonly Pick<PlanStep, "status">[]) {
  const done = steps.filter(step => step.status === "completed").length;
  const deferred = steps.filter(step => step.status === "deferred").length;
  const active = steps.length - deferred;
  if (!deferred) return `${done}/${steps.length}`;
  return active ? `${done}/${active} · ${deferred} 项暂缓` : `${deferred} 项暂缓`;
}
