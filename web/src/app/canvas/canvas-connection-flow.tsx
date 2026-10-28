import { useId } from "react";
import type { CanvasPoint } from "./canvas-connections";

export function CanvasConnectionFlow({ connectionID, path, start, end, zoom }: {
  connectionID: string;
  path: string;
  start: CanvasPoint;
  end: CanvasPoint;
  zoom: number;
}) {
  const id = useId();
  const maskID = `${id}-mask`;
  const filterID = `${id}-blur`;
  const maskWidth = Math.max(16, 8 / zoom);
  const padding = Math.max(24, maskWidth);
  const bend = Math.max(Math.abs(end.x - start.x) / 2, 50);
  const bounds = {
    x: Math.min(start.x, end.x) - bend - padding,
    y: Math.min(start.y, end.y) - padding,
    width: Math.abs(end.x - start.x) + 2 * (bend + padding),
    height: Math.abs(end.y - start.y) + 2 * padding,
  };

  return <g data-canvas-connection-flow={connectionID} aria-hidden="true" className="pointer-events-none">
    <defs>
      <filter id={filterID} filterUnits="userSpaceOnUse" {...bounds} colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation="5" />
        <feComponentTransfer><feFuncA type="linear" slope="1.5" /></feComponentTransfer>
      </filter>
      <mask id={maskID} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...bounds} style={{ maskType: "alpha" }}>
        {/* Smooth the opacity field, then clip it to one crisp stroke below. */}
        <g filter={`url(#${filterID})`} fill="none" stroke="white" strokeWidth={maskWidth} strokeLinecap="butt">
          <path d={path} className="canvas-connection-flow canvas-connection-flow-tail" />
          <path d={path} className="canvas-connection-flow canvas-connection-flow-trail" />
          <path d={path} className="canvas-connection-flow canvas-connection-flow-neck" />
          <path d={path} className="canvas-connection-flow canvas-connection-flow-head" />
        </g>
      </mask>
    </defs>
    <g mask={`url(#${maskID})`} fill="none" stroke="var(--canvas-connection-flow)">
      <path d={path} strokeWidth="6" opacity="0.16" vectorEffect="non-scaling-stroke" />
      <path d={path} strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </g>
  </g>;
}
