export type CanvasTool = "select" | "pan";

export const CANVAS_AGENT_WIDTH = 420;

const CANVAS_DOCK_STACK_BREAKPOINT = 1120;

export function canvasWorkspaceControlsStacked(width: number, sidePanelOpen: boolean, agentOpen: boolean, viewInset = 0) {
  // Hidden entries free space on both sides of the centered action toolbar.
  return width < CANVAS_DOCK_STACK_BREAKPOINT - (sidePanelOpen ? 196 : 0) - (agentOpen ? 56 : 0) + viewInset * 2;
}
