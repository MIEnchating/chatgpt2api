import { createExpiringRequestCache, type ExpiringRequestCache } from "@/lib/expiring-request-cache";

export type BananaPromptMode = "generate" | "edit";
export type PromptMarketSourceId = string;
export type PromptMarketLanguage = "zh-CN" | "en";
type PromptMarketSourceFormat = "reference-project" | "banana-json" | "awesome-gpt-image-2-markdown" | "generic-json";

export type PromptMarketSourceConfig = {
  id: string;
  label: string;
  url: string;
  homepage?: string;
  format: PromptMarketSourceFormat;
  enabled: boolean;
  builtin?: boolean;
};

export type PromptMarketLocalization = {
  title: string;
  prompt: string;
  category: string;
  subCategory?: string;
};

export type BananaPrompt = {
  id: string;
  title: string;
  preview: string;
  referenceImageUrls: string[];
  prompt: string;
  author: string;
  link?: string;
  mode?: BananaPromptMode;
  category: string;
  subCategory?: string;
  tags: string[];
  created?: string;
  source: PromptMarketSourceId;
  sourceLabel: string;
  isNsfw: boolean;
  localizations?: Partial<Record<PromptMarketLanguage, PromptMarketLocalization>>;
};

export function promptMatchesKeyword(prompt: Pick<BananaPrompt, "title" | "prompt">, keyword: string) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return true;
  return prompt.title.toLowerCase().includes(normalizedKeyword) || prompt.prompt.toLowerCase().includes(normalizedKeyword);
}

export function sortPromptMarketPrompts(prompts: BananaPrompt[]) {
  return prompts
    .map((prompt, index) => ({ prompt, index, timestamp: Date.parse(prompt.created || "") }))
    .sort((left, right) => {
      const leftTimestamp = Number.isFinite(left.timestamp) ? left.timestamp : Number.NEGATIVE_INFINITY;
      const rightTimestamp = Number.isFinite(right.timestamp) ? right.timestamp : Number.NEGATIVE_INFINITY;
      return rightTimestamp - leftTimestamp || left.index - right.index;
    })
    .map(({ prompt }) => prompt);
}

const BANANA_PROMPTS_URL =
  "https://raw.githubusercontent.com/glidea/banana-prompt-quicker/main/prompts.json";
const AWESOME_GPT_IMAGE_2_PROMPTS_RAW_BASE_URL =
  "https://raw.githubusercontent.com/shalinda-j/awesome-gpt-image-2-prompts/main/";

export const DEFAULT_PROMPT_MARKET_SOURCES: PromptMarketSourceConfig[] = [
  {
    id: "gpt-image-2-prompts",
    label: "GPT Image 2 Prompts",
    url: "https://raw.githubusercontent.com/tigerowo/awesome-gpt-image-2-prompts/main",
    homepage: "https://github.com/tigerowo/awesome-gpt-image-2-prompts",
    format: "reference-project",
    enabled: true,
    builtin: true,
  },
  {
    id: "awesome-gpt-image",
    label: "Awesome GPT Image",
    url: "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main",
    homepage: "https://github.com/ZeroLu/awesome-gpt-image",
    format: "reference-project",
    enabled: true,
    builtin: true,
  },
  {
    id: "awesome-gpt4o-image-prompts",
    label: "Awesome GPT4o Image Prompts",
    url: "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main",
    homepage: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts",
    format: "reference-project",
    enabled: true,
    builtin: true,
  },
  {
    id: "xianyu-awesome-gptimage2",
    label: "Xianyu Awesome GPT Image 2",
    url: "https://raw.githubusercontent.com/xianyu110/awesome-gptimage2/main",
    homepage: "https://github.com/xianyu110/awesome-gptimage2",
    format: "reference-project",
    enabled: true,
    builtin: true,
  },
  {
    id: "youmind-gpt-image-2",
    label: "YouMind GPT Image 2",
    url: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main",
    homepage: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2",
    format: "reference-project",
    enabled: true,
    builtin: true,
  },
  {
    id: "youmind-nano-banana-pro",
    label: "YouMind Nano Banana Pro",
    url: "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main",
    homepage: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts",
    format: "reference-project",
    enabled: true,
    builtin: true,
  },
  {
    id: "davidwu-gpt-image2-prompts",
    label: "awesome-gpt-image2-prompts",
    url: "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main",
    homepage: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts",
    format: "reference-project",
    enabled: true,
    builtin: true,
  },
];

const PROMPT_MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const promptMarketCaches = new Map<string, ExpiringRequestCache<BananaPrompt[]>>();

function promptMarketSourceCacheKey(sources: PromptMarketSourceConfig[]) {
  return JSON.stringify(sources.map(({ id, label, url, homepage, format, enabled }) => ({
    id,
    label,
    url,
    homepage: homepage || "",
    format,
    enabled,
  })));
}

function abortError() {
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}

function waitForPromptMarketRequest(request: Promise<BananaPrompt[]>, signal?: AbortSignal) {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<BananaPrompt[]>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const BANANA_SOURCE: PromptMarketSourceConfig = {
  id: "banana-prompt-quicker",
  label: "Banana 提示词",
  url: BANANA_PROMPTS_URL,
  format: "banana-json",
  enabled: true,
};
const AWESOME_GPT_IMAGE_2_SOURCE: PromptMarketSourceConfig = {
  id: "awesome-gpt-image-2-prompts",
  label: "GPT Image 2 案例",
  url: AWESOME_GPT_IMAGE_2_PROMPTS_RAW_BASE_URL,
  format: "awesome-gpt-image-2-markdown",
  enabled: true,
};


export function normalizePromptMarketSources(value: unknown): PromptMarketSourceConfig[] {
  const configuredByID = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value)) value.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const raw = item as Record<string, unknown>;
    const id = String(raw.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (id && !configuredByID.has(id)) configuredByID.set(id, raw);
  });

  const builtinIDs = new Set(DEFAULT_PROMPT_MARKET_SOURCES.map((source) => source.id));
  const sources = DEFAULT_PROMPT_MARKET_SOURCES.map((source) => ({
    ...source,
    enabled: configuredByID.get(source.id)?.enabled !== false,
  }));
  const seen = new Set(builtinIDs);
  configuredByID.forEach((raw, id) => {
    if (seen.has(id) || raw.builtin === true) return;
    const label = String(raw.label || "").trim();
    const url = String(raw.url || "").trim();
    const homepageValue = String(raw.homepage || "").trim();
    const homepage = /^https?:\/\//i.test(homepageValue) ? homepageValue : undefined;
    const format = String(raw.format || "") as PromptMarketSourceFormat;
    if (!label || !/^https?:\/\//i.test(url) || format !== "generic-json") return;
    seen.add(id);
    sources.push({ id, label, url, ...(homepage ? { homepage } : {}), format, enabled: raw.enabled !== false });
  });
  return sources;
}

type BananaPromptSourceItem = {
  id?: unknown;
  title?: unknown;
  title_cn?: unknown;
  cover_url?: unknown;
  coverUrl?: unknown;
  image?: unknown;
  preview?: unknown;
  reference_image_urls?: unknown;
  referenceImageUrls?: unknown;
  description?: unknown;
  prompt?: unknown;
  author?: unknown;
  link?: unknown;
  mode?: unknown;
  category?: unknown;
  sub_category?: unknown;
  tags?: unknown;
  created?: unknown;
};

const MARKDOWN_CASE_HEADING_PATTERN =
  /^### Case\s+(\d+):\s+\[([^\]]+)]\(([^)]+)\)\s+\(by\s+\[([^\]]+)]\(([^)]+)\)\)/;
const MARKDOWN_IMAGE_PATTERN = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/i;
const MARKDOWN_PROMPT_PATTERN =
  /\*{2,}\s*(?:Prompt|提示词)\s*[:：]\s*\*{2,}\s*\n\s*```(?:\w+)?\n([\s\S]*?)\n```/i;
const IGNORED_MARKET_README_HEADINGS = new Set(["简介", "最新动态", "Menu", "致谢", "Star History"]);
const NSFW_TEXT_PATTERN =
  /\b(nsfw|nude|naked|lingerie|erotic|seductive|sexy|cleavage|underwear|panties|bra|bikini|ahegao|explicit|sensual|fetish|nipples?|genitals?|buttocks?|thong|topless)\b|裸|色情|情色|性感|诱惑|内衣|内裤|乳|胸|臀|私处|泳衣|比基尼|情趣|丁字裤|翻白眼|吐舌|妩媚|暧昧/i;

type AwesomePromptDraft = BananaPrompt & {
  language: PromptMarketLanguage;
  mergeKey: string;
};

const EMPTY_PROMPT_PREVIEW = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

function normalizePromptMode(value: unknown): BananaPromptMode | undefined {
  return value === "edit" || value === "generate" ? value : undefined;
}

function buildPromptId(item: BananaPromptSourceItem, index: number) {
  return [item.title, item.author, index]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(":");
}

function normalizeReferenceImageUrls(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((url): url is string => typeof url === "string" && url.trim().length > 0);
}

function isNsfwPrompt(category: string, title: string, prompt: string) {
  return category === "NSFW" || NSFW_TEXT_PATTERN.test(`${category}\n${title}\n${prompt}`);
}

function normalizeTags(...values: unknown[]) {
  const tags = values.flatMap((value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，/|]+/) : []);
  return Array.from(
    new Set(
      tags
        .map((tag) => String(tag).trim())
        .filter(Boolean),
    ),
  ).slice(0, 24);
}

function normalizePrompt(item: BananaPromptSourceItem, index: number, source: PromptMarketSourceConfig): BananaPrompt | null {
  const title = String(item.title_cn || item.title || "").trim();
  const preview = String(
    source.format === "generic-json"
      ? item.coverUrl || EMPTY_PROMPT_PREVIEW
      : item.preview || item.cover_url || item.image || EMPTY_PROMPT_PREVIEW,
  ).trim();
  const prompt = String(item.prompt || "").trim();
  const author = String(item.author || source.label).trim();
  const category =
    typeof item.category === "string" && item.category.trim() ? item.category.trim() : "未分类";
  const mode = normalizePromptMode(item.mode);
  if (!title || !prompt || !author) {
    return null;
  }

  return {
    id: `${source.id}:${String(item.id || buildPromptId(item, index))}`,
    title,
    preview,
    prompt,
    author,
    referenceImageUrls: normalizeReferenceImageUrls(
      source.format === "generic-json" ? item.referenceImageUrls : item.reference_image_urls,
    ),
    link: typeof item.link === "string" && item.link.trim() ? item.link.trim() : undefined,
    ...(mode ? { mode } : {}),
    category,
    subCategory: typeof item.sub_category === "string" && item.sub_category.trim() ? item.sub_category.trim() : undefined,
    tags: normalizeTags(item.tags),
    created: typeof item.created === "string" && item.created.trim() ? item.created.trim() : undefined,
    source: source.id,
    sourceLabel: source.label,
    isNsfw: category === "NSFW",
  };
}

function normalizeMarkdownImageUrl(value: string) {
  const imageUrl = value.trim();
  if (!imageUrl) {
    return "";
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    return imageUrl;
  }
  return new URL(imageUrl.replace(/^\.\//, ""), AWESOME_GPT_IMAGE_2_PROMPTS_RAW_BASE_URL).toString();
}

function buildAwesomePromptMergeKey(link: string, preview: string) {
  return `${link.trim()}|${preview.trim()}`;
}

function cleanMarkdownHeading(value: string) {
  return value
    .replace(/^#+\s*/, "")
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, "")
    .trim();
}

function normalizeAwesomePromptSection(
  section: string,
  category: string,
  language: PromptMarketLanguage,
  source: PromptMarketSourceConfig,
): AwesomePromptDraft | null {
  const heading = section.match(MARKDOWN_CASE_HEADING_PATTERN);
  const image = section.match(MARKDOWN_IMAGE_PATTERN);
  const promptBlock = section.match(MARKDOWN_PROMPT_PATTERN);
  if (!heading || !image || !promptBlock) {
    return null;
  }

  const caseNumber = heading[1].trim();
  const title = heading[2].trim();
  const link = heading[3].trim();
  const author = heading[4].trim();
  const preview = normalizeMarkdownImageUrl(image[1]);
  const prompt = promptBlock[1].trim();
  if (!caseNumber || !title || !preview || !prompt || !author) {
    return null;
  }

  return {
    id: `${source.id}:${buildAwesomePromptMergeKey(link, preview)}`,
    title,
    preview,
    referenceImageUrls: [],
    prompt,
    author,
    link,
    category,
    subCategory: `Case ${caseNumber}`,
    tags: normalizeTags(category),
    source: source.id,
    sourceLabel: source.label,
    isNsfw: isNsfwPrompt(category, title, prompt),
    language,
    mergeKey: buildAwesomePromptMergeKey(link, preview),
    localizations: {
      [language]: {
        title,
        prompt,
        category,
        subCategory: `Case ${caseNumber}`,
      },
    },
  };
}

function parseAwesomePrompts(markdown: string, language: PromptMarketLanguage, source: PromptMarketSourceConfig) {
  const lines = markdown.split(/\r?\n/);
  const prompts: AwesomePromptDraft[] = [];
  let activeCategory = "未分类";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      const heading = cleanMarkdownHeading(line);
      if (heading && !IGNORED_MARKET_README_HEADINGS.has(heading)) {
        activeCategory = heading;
      }
      continue;
    }
    if (!line.startsWith("### Case ")) {
      continue;
    }

    const sectionStart = index;
    let sectionEnd = lines.length;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      if (lines[nextIndex].startsWith("### Case ") || lines[nextIndex].startsWith("## ")) {
        sectionEnd = nextIndex;
        break;
      }
    }

    const prompt = normalizeAwesomePromptSection(
      lines.slice(sectionStart, sectionEnd).join("\n"),
      activeCategory,
      language,
      source,
    );
    if (prompt) {
      prompts.push(prompt);
    }
    index = sectionEnd - 1;
  }

  return prompts;
}

function mergeAwesomePrompts(...groups: AwesomePromptDraft[][]) {
  const promptsByKey = new Map<string, AwesomePromptDraft>();

  groups.flat().forEach((prompt) => {
    const current = promptsByKey.get(prompt.mergeKey);
    if (!current) {
      promptsByKey.set(prompt.mergeKey, prompt);
      return;
    }

    current.localizations = {
      ...current.localizations,
      ...prompt.localizations,
    };
    current.isNsfw = current.isNsfw || prompt.isNsfw;
    if (current.language !== "zh-CN" && prompt.language === "zh-CN") {
      current.title = prompt.title;
      current.prompt = prompt.prompt;
      current.category = prompt.category;
      current.subCategory = prompt.subCategory;
      current.language = prompt.language;
    }
  });

  return [...promptsByKey.values()].map(({ language: _language, mergeKey: _mergeKey, ...prompt }) => prompt);
}

async function fetchBananaPrompts(signal?: AbortSignal, source: PromptMarketSourceConfig = BANANA_SOURCE) {
  const response = await fetch(source.url || BANANA_PROMPTS_URL, {
    signal,
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`读取提示词市场失败：${response.status}`);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("提示词市场数据格式无效");
  }

  return data.flatMap((item, index) => {
    const prompt = normalizePrompt(item as BananaPromptSourceItem, index, source);
    return prompt ? [prompt] : [];
  });
}

async function fetchAwesomeGptImage2Prompts(signal?: AbortSignal, source: PromptMarketSourceConfig = AWESOME_GPT_IMAGE_2_SOURCE) {
  const baseURL = source.url.endsWith("/") ? source.url : `${source.url}/`;
  const fetchMarkdown = async (url: string, languageLabel: string) => {
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "text/markdown,text/plain",
      },
    });
    if (!response.ok) {
      throw new Error(`读取 awesome-gpt-image-2-prompts ${languageLabel}提示词失败：${response.status}`);
    }
    return response.text();
  };

  const [zhResult, enResult] = await Promise.allSettled([
    fetchMarkdown(`${baseURL}README_zh-CN.md`, "中文"),
    fetchMarkdown(`${baseURL}README.md`, "英文"),
  ]);

  const zhPrompts = zhResult.status === "fulfilled" ? parseAwesomePrompts(zhResult.value, "zh-CN", source) : [];
  const enPrompts = enResult.status === "fulfilled" ? parseAwesomePrompts(enResult.value, "en", source) : [];
  if (zhPrompts.length === 0 && enPrompts.length === 0) {
    const failure = zhResult.status === "rejected" ? zhResult.reason : enResult.status === "rejected" ? enResult.reason : null;
    throw failure instanceof Error ? failure : new Error("awesome-gpt-image-2-prompts 数据格式无效");
  }

  return mergeAwesomePrompts(zhPrompts, enPrompts);
}

async function fetchGenericJSONPrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  const response = await fetch(source.url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`读取 ${source.label} 失败：${response.status}`);
  const raw: unknown = await response.json();
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as Record<string, unknown>).items || (raw as Record<string, unknown>).prompts : null;
  if (!Array.isArray(items)) throw new Error(`${source.label} 数据格式无效`);
  return items.flatMap((item, index) => {
    const prompt = normalizePrompt(item as BananaPromptSourceItem, index, source);
    return prompt ? [prompt] : [];
  });
}

export async function fetchPromptMarketSourcePrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  if (source.format === "reference-project") {
    const { fetchReferencePromptSource } = await import("@/app/image/reference-prompt-sources");
    return fetchReferencePromptSource(source, signal);
  }
  if (source.format === "banana-json") return fetchBananaPrompts(signal, source);
  if (source.format === "awesome-gpt-image-2-markdown") return fetchAwesomeGptImage2Prompts(signal, source);
  return fetchGenericJSONPrompts(source, signal);
}

export async function fetchPromptMarketPrompts(signal?: AbortSignal, configuredSources: PromptMarketSourceConfig[] = DEFAULT_PROMPT_MARKET_SOURCES) {
  const sources = normalizePromptMarketSources(configuredSources).filter((source) => source.enabled);
  const cacheKey = promptMarketSourceCacheKey(sources);
  let cache = promptMarketCaches.get(cacheKey);
  if (!cache) {
    cache = createExpiringRequestCache<BananaPrompt[]>(PROMPT_MARKET_CACHE_TTL_MS);
    promptMarketCaches.set(cacheKey, cache);
  }
  const request = cache.get(async () => {
    const results = await Promise.allSettled(sources.map((source) => fetchPromptMarketSourcePrompts(source)));
    const prompts = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (prompts.length > 0) return prompts;

    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    throw failure?.reason instanceof Error ? failure.reason : new Error("读取提示词市场失败");
  });
  return waitForPromptMarketRequest(request, signal);
}
