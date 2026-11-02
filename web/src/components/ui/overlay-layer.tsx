import type { ComponentProps } from "react";
import { createPortal } from "react-dom";
import type { OverlayKind } from "@/lib/overlay-layers";
import { OverlayLayerProvider, useOverlayLayer } from "@/lib/use-overlay-layer";

// Custom portals must propagate their layer just like the shared primitives.
export function OverlaySurface({ kind = "modal", style, children, ...props }: ComponentProps<"div"> & { kind?: OverlayKind }) {
  const layer = useOverlayLayer(kind);
  return createPortal(
    <OverlayLayerProvider value={layer}>
      <div {...props} data-overlay-layer={layer} style={{ pointerEvents: "auto", ...style, zIndex: layer }}>{children}</div>
    </OverlayLayerProvider>,
    document.body,
  );
}
