export const PANORAMA_IMAGE_SIZE = "2:1";
export const PANORAMA_NODE_SIZE = { width: 340, height: 170 } as const;

function isLocalPanoramaHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".localhost")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 10 || first === 127 || first === 169 && second === 254 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

export function panoramaProxyURL(url: string, currentHost = typeof window === "undefined" ? "" : window.location.host) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return url;
  try {
    const parsed = new URL(url);
    if (isLocalPanoramaHost(parsed.hostname) || parsed.host === currentHost) return url;
  } catch {
    return url;
  }
  return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

const SPHERICAL_PROMPT = "最终图片必须是等距柱状投影的完整球形全景图，比例2比1，宽度是高度的2倍，只输出一张连续画面，适合作为 3D 导演台环境球内壁贴图。水平视角覆盖完整360度，垂直视角覆盖从天空或天花板到地面或地板的完整180度，观看者位于场景中心，可以向上、向下、向左、向右完整环视整个环境，地平线必须位于画面垂直中心附近，左右边缘必须自然无缝衔接，不要普通横幅照片、不要21比9电影宽银幕截图、不要鱼眼圆形边框、不要多图拼接、不要文字、水印、边框或明显接缝";
const IMAGE_FALLBACK = "这是图生{{projectionLabel}}全景任务。如果参考图已经是全景环境图，请保留它的场景主体并只修正为全景查看器可用的几何结构；如果参考图不是全景比例，请把它作为场景参考，生成四周缺失的环境内容，不要简单拉伸原图。{{projectionPrompt}}, {{commonPrompt}}, {{userPrompt}}";
const TEXT_FALLBACK = "这是文字生成{{projectionLabel}}全景任务。结合用户文字和所有参考图，参考图只用于主体、材质、色彩、构图线索和风格，最终必须生成完整全景环境。先生成符合目标全景几何的底图，之后会进入全景查看器归一化处理。{{projectionPrompt}}, {{commonPrompt}}, {{userPrompt}}";
const COMMON_PROMPT = [
  "最终图像必须适合导入 3D 导演台或全景查看器，作为包裹场景的环境球内壁或水平环绕背景使用",
  "画面中不要出现摄影师、相机、镜头、三脚架、头显或任何拍摄设备",
  "不要分屏拼贴，不要多宫格，不要画中画，不要插入小图，只保留一个连续环境",
  "不要水印，不要文字，不要界面元素，不要边框，不要明显拼接线或接缝",
  "除非用户另有说明，保持真实摄影质感、电影级光影和自然空间纵深",
].join(", ");

export function buildPanoramaPrompt(userPrompt: string, hasReferenceImages: boolean) {
  return Object.entries({
    "{{projectionLabel}}": "720度球形",
    "{{projectionPrompt}}": SPHERICAL_PROMPT,
    "{{commonPrompt}}": COMMON_PROMPT,
    "{{userPrompt}}": userPrompt.trim(),
  }).reduce((result, [token, value]) => result.split(token).join(value), hasReferenceImages ? IMAGE_FALLBACK : TEXT_FALLBACK);
}

export function panoramaRetryPrompt(finalPrompt: string | undefined) {
  return String(finalPrompt || "").trim();
}

export function panoramaRetryReferenceURLs(
  generationType: "generation" | "edit" | undefined,
  referenceURLs: readonly string[] | undefined,
) {
  if (generationType !== "edit") return [];
  return [...new Set((referenceURLs || []).map((url) => url.trim()).filter(Boolean))];
}

export function panoramaGenerationQuality(value: string | undefined) {
  const quality = String(value || "").trim().toLowerCase();
  return quality && quality !== "auto" ? quality : "medium";
}

export function panoramaGenerationCount(value: number | undefined) {
  return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value))) || 1));
}

export function isStrictPanoramaSize(width: number, height: number) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width === height * 2;
}
