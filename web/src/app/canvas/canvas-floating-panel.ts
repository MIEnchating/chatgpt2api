export type CanvasFloatingPanelPlacement = {
  direction: "above" | "below";
  left: number;
  width: number;
  maxHeight: number;
};

export type CanvasNodeToolbarPlacement = {
  compact: boolean;
  left: number;
  right?: number;
  top: number;
};

export function canvasFloatingPanelPlacement({
  anchor,
  viewportWidth,
  viewportHeight,
  preferredWidth = 360,
  preferredHeight = 260,
  padding = 12,
  gap = 8,
}: {
  anchor: Pick<DOMRect, "left" | "top" | "right" | "bottom">;
  viewportWidth: number;
  viewportHeight: number;
  preferredWidth?: number;
  preferredHeight?: number;
  padding?: number;
  gap?: number;
}): CanvasFloatingPanelPlacement {
  const width = Math.max(0, Math.min(preferredWidth, viewportWidth - padding * 2));
  const left = Math.max(padding, Math.min(anchor.left, viewportWidth - width - padding));
  const availableAbove = Math.max(0, anchor.top - gap - padding);
  const availableBelow = Math.max(0, viewportHeight - anchor.bottom - gap - padding);
  const direction = availableAbove >= preferredHeight || availableAbove >= availableBelow ? "above" : "below";
  return {
    direction,
    left,
    width,
    maxHeight: direction === "above" ? availableAbove : availableBelow,
  };
}

export function canvasNodeToolbarPlacement({ nodeCenterX, nodeTopY, viewportWidth }: { nodeCenterX: number; nodeTopY: number; viewportWidth: number }): CanvasNodeToolbarPlacement {
  const compact = viewportWidth > 0 && viewportWidth < 640;
  return compact
    ? { compact, left: 12, right: 12, top: Math.max(116, nodeTopY) }
    : { compact, left: nodeCenterX, top: Math.max(72, nodeTopY) };
}
