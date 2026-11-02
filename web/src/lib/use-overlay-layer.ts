import { createContext, useContext } from "react";
import { overlayLayer, type OverlayKind } from "@/lib/overlay-layers";

const OverlayLayerContext = createContext(0);
export const OverlayLayerProvider = OverlayLayerContext.Provider;

export function useOverlayLayer(kind: OverlayKind) {
  return overlayLayer(kind, useContext(OverlayLayerContext));
}
