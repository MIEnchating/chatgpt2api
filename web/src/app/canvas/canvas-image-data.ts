export type CanvasImageCropRect = { x: number; y: number; width: number; height: number };
export type CanvasImageSplitParams = { rows: number; columns: number; horizontalLines?: number[]; verticalLines?: number[] };
export type CanvasImageSplitPiece = { row: number; column: number; dataUrl: string };
export type CanvasImageUpscaleAlgorithm = "nearest" | "bilinear" | "high";
export type CanvasImageUpscaleParams = { targetLongEdge: number; algorithm: CanvasImageUpscaleAlgorithm };
export type CanvasImageAngleParams = { horizontalAngle: number; pitchAngle: number; cameraDistance: number; wideAngle: boolean };

export const CANVAS_MAX_UPSCALE_LONG_EDGE = 4096;

export async function cropCanvasImage(dataURL: string, crop: CanvasImageCropRect) {
  const image = await loadCanvasImage(dataURL);
  return drawCanvasCrop(image, Math.floor(crop.x * image.width), Math.floor(crop.y * image.height), Math.ceil(crop.width * image.width), Math.ceil(crop.height * image.height));
}

export async function splitCanvasImage(dataURL: string, params: CanvasImageSplitParams): Promise<CanvasImageSplitPiece[]> {
  const image = await loadCanvasImage(dataURL);
  const rows = clampGrid(params.rows);
  const columns = clampGrid(params.columns);
  const xCuts = splitCuts(params.verticalLines, image.width, columns);
  const yCuts = splitCuts(params.horizontalLines, image.height, rows);
  const pieces: CanvasImageSplitPiece[] = [];
  for (let row = 0; row < yCuts.length - 1; row += 1) {
    for (let column = 0; column < xCuts.length - 1; column += 1) {
      pieces.push({
        row,
        column,
        dataUrl: drawCanvasCrop(image, xCuts[column], yCuts[row], xCuts[column + 1] - xCuts[column], yCuts[row + 1] - yCuts[row]),
      });
    }
  }
  return pieces;
}

export function resolveCanvasUpscaleSize(width: number, height: number, targetLongEdge: number) {
  const longEdge = Math.max(1, width, height);
  const target = Math.min(CANVAS_MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(targetLongEdge)));
  const scale = target / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function upscaleCanvasImage(dataURL: string, params: CanvasImageUpscaleParams) {
  const image = await loadCanvasImage(dataURL);
  const size = resolveCanvasUpscaleSize(image.width, image.height, params.targetLongEdge);
  return params.algorithm === "high"
    ? drawStepUpscale(image, size.width, size.height)
    : drawCanvasResize(image, image.width, image.height, size.width, size.height, params.algorithm);
}

export function buildCanvasGridLines(count: number) {
  const safeCount = clampGrid(count);
  return Array.from({ length: safeCount - 1 }, (_, index) => (index + 1) / safeCount);
}

export function clampCanvasGrid(value: number) {
  return clampGrid(value);
}

export function findCanvasGridLineSpot(lines: readonly number[]) {
  const cuts = [0, ...lines, 1].sort((a, b) => a - b);
  let spot = 0.5;
  let largestGap = 0;
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const gap = cuts[index + 1] - cuts[index];
    if (gap > largestGap) {
      largestGap = gap;
      spot = cuts[index] + gap / 2;
    }
  }
  return spot;
}

export function nextCanvasUpscaleTarget(sourceLongEdge: number) {
  return [1024, 2048, CANVAS_MAX_UPSCALE_LONG_EDGE].find((target) => sourceLongEdge < target) || CANVAS_MAX_UPSCALE_LONG_EDGE;
}

export function canvasImageAngleLabel(params: CanvasImageAngleParams) {
  const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
  const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
  return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

export function canvasImageAnglePrompt(params: CanvasImageAngleParams) {
  return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${canvasImageAngleLabel(params)}。`;
}

function splitCuts(lines: readonly number[] | undefined, size: number, count: number) {
  if (!lines?.length) return Array.from({ length: count + 1 }, (_, index) => Math.floor((index * size) / count));
  return [0, ...lines.map((line) => Math.round(line * size)).filter((line) => line > 0 && line < size).sort((a, b) => a - b), size];
}

function clampGrid(value: number) {
  return Math.min(12, Math.max(1, Math.round(Number.isFinite(value) ? value : 1)));
}

function drawCanvasCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, sw);
  canvas.height = Math.max(1, sh);
  const context = canvas.getContext("2d");
  if (!context) return image.src;
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function drawStepUpscale(image: HTMLImageElement, width: number, height: number) {
  let source: CanvasImageSource = image;
  let sourceWidth = image.width;
  let sourceHeight = image.height;
  while (sourceWidth * 2 < width && sourceHeight * 2 < height) {
    const nextWidth = sourceWidth * 2;
    const nextHeight = sourceHeight * 2;
    source = drawCanvasResizeCanvas(source, sourceWidth, sourceHeight, nextWidth, nextHeight, "high");
    sourceWidth = nextWidth;
    sourceHeight = nextHeight;
  }
  return drawCanvasResize(source, sourceWidth, sourceHeight, width, height, "high");
}

function drawCanvasResize(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: CanvasImageUpscaleAlgorithm) {
  return drawCanvasResizeCanvas(source, sourceWidth, sourceHeight, width, height, algorithm).toDataURL("image/png");
}

function drawCanvasResizeCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, algorithm: CanvasImageUpscaleAlgorithm) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.imageSmoothingEnabled = algorithm !== "nearest";
  context.imageSmoothingQuality = algorithm === "bilinear" ? "medium" : "high";
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  return canvas;
}

function loadCanvasImage(dataURL: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片"));
    image.src = dataURL;
  });
}
