// Page-local stacking stays below 100. Each modal owns a separate 1000-wide
// scope, so background menus cannot cover a dialog and its nested overlays.
export const OVERLAY_LAYER = {
  popover: 100,
  select: 200,
  tooltip: 300,
  modal: 1000,
  notification: 100000,
} as const;

export type OverlayKind = "modal" | "popover" | "select" | "tooltip";

export function overlayLayer(kind: OverlayKind, parent = 0): number {
  const scope = Math.floor(parent / OVERLAY_LAYER.modal) * OVERLAY_LAYER.modal;
  return kind === "modal"
    ? scope + OVERLAY_LAYER.modal
    : Math.max(scope + OVERLAY_LAYER[kind], parent + 1);
}
