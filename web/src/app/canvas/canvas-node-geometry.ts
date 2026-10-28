export type CanvasAspectNode = {
  width: number;
  height: number;
  natural_width?: number;
  natural_height?: number;
};

export function canvasNodeAspectRatio(node: CanvasAspectNode) {
  return (node.natural_width || node.width) / Math.max(1, node.natural_height || node.height);
}

export function canvasCroppedNodeSize(sourceWidth: number, imageWidth: number, imageHeight: number) {
  const safeWidth = Math.max(1, imageWidth);
  const safeHeight = Math.max(1, imageHeight);
  const width = Math.min(Math.max(1, sourceWidth), Math.max(220, safeWidth));
  return { width, height: width * (safeHeight / safeWidth) };
}

export function canvasCenteredNodePosition(center: { x: number; y: number }, width: number, height: number) {
  return { x: center.x - width / 2, y: center.y - height / 2 };
}

export function canvasImageReplacementFrame(
  node: { x: number; y: number },
  width: number,
  height: number,
) {
  return { x: node.x, y: node.y, width, height };
}

export function canvasNodeSizeFromRatio(
  size: string,
  baseWidth: number,
  baseHeight: number,
) {
  const match = size.match(/^(\d+)(?:x|:)(\d+)/);
  if (!match) return null;
  const ratio = Number(match[1]) / Math.max(1, Number(match[2]));
  if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
  const edge = Math.max(baseWidth, baseHeight);
  return ratio >= 1
    ? { width: edge, height: edge / ratio }
    : { width: edge * ratio, height: edge };
}

export function canvasEmptyImageFrameFromSize(
  node: { x: number; y: number; width: number; height: number },
  size: string,
  baseWidth = 340,
  baseHeight = 240,
) {
  const edge = Math.max(node.width, node.height) || Math.max(baseWidth, baseHeight);
  const dimensions = canvasNodeSizeFromRatio(size, edge, edge);
  if (!dimensions) return null;
  return {
    x: node.x + node.width / 2 - dimensions.width / 2,
    y: node.y + node.height / 2 - dimensions.height / 2,
    ...dimensions,
  };
}
