export type CanvasAgentRunSlot = {
  current: AbortController | null;
};

export type CanvasAgentRunLifecycle = {
  mounted: boolean;
  epoch: number;
};

export function createCanvasAgentRunLifecycle(): CanvasAgentRunLifecycle {
  return { mounted: false, epoch: 0 };
}

export function mountCanvasAgentRunLifecycle(lifecycle: CanvasAgentRunLifecycle) {
  lifecycle.mounted = true;
}

export function beginCanvasAgentRunEpoch(lifecycle: CanvasAgentRunLifecycle) {
  lifecycle.epoch += 1;
  return lifecycle.epoch;
}

export function invalidateCanvasAgentRunLifecycle(lifecycle: CanvasAgentRunLifecycle) {
  lifecycle.mounted = false;
  lifecycle.epoch += 1;
}

export function isCurrentCanvasAgentRun(lifecycle: CanvasAgentRunLifecycle, epoch: number) {
  return lifecycle.mounted && lifecycle.epoch === epoch;
}

export function claimCanvasAgentRun(slot: CanvasAgentRunSlot) {
  if (slot.current) return null;
  const controller = new AbortController();
  slot.current = controller;
  return controller;
}

export function releaseCanvasAgentRun(slot: CanvasAgentRunSlot, controller: AbortController) {
  if (slot.current !== controller) return false;
  slot.current = null;
  return true;
}

export function abortCanvasAgentRun(slot: CanvasAgentRunSlot) {
  if (!slot.current) return false;
  slot.current.abort();
  return true;
}
