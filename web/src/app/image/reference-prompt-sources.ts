import type { BananaPrompt, PromptMarketSourceConfig } from "@/app/image/banana-prompts";

const TIGER_CASE_FILES = ["README.md", "cases/ad-creative.md", "cases/character.md", "cases/comparison.md", "cases/ecommerce.md", "cases/portrait.md", "cases/poster.md", "cases/ui.md"];

export async function fetchReferencePromptSource(source: PromptMarketSourceConfig, signal?: AbortSignal): Promise<BananaPrompt[]> {
  switch (source.id) {
    case "gpt-image-2-prompts": return fetchTigerPrompts(source, signal);
    case "awesome-gpt-image": return fetchZeroLuPrompts(source, signal);
    case "awesome-gpt4o-image-prompts": return fetchImgEdifyPrompts(source, signal);
    case "xianyu-awesome-gptimage2": return fetchXianyuPrompts(source, signal);
    case "youmind-gpt-image-2": return fetchYouMindPrompts(source, "gpt-image-2", signal);
    case "youmind-nano-banana-pro": return fetchYouMindPrompts(source, "nano-banana-pro", signal);
    case "davidwu-gpt-image2-prompts": return fetchDavidWuPrompts(source, signal);
    case "freestylefly-gpt-image-2": return fetchFreestyleflyPrompts(source, signal);
    default: throw new Error(`不支持的参考项目提示词源：${source.label}`);
  }
}

async function fetchTigerPrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  const [index, ...markdownFiles] = await Promise.all([
    fetchJSON<{ records?: Array<{ title?: string; tweet_url?: string; image_dir?: string; category?: string; added_at?: string }> }>(sourceURL(source, "data/ingested_tweets.json"), signal),
    ...TIGER_CASE_FILES.map((file) => fetchText(sourceURL(source, file), signal)),
  ]);
  const cases = new Map<string, { prompt: string; image: string }>();
  markdownFiles.forEach((markdown) => collectTigerCases(source, markdown, cases));
  return (index.records || []).flatMap((record, indexValue) => {
    const item = cases.get(clean(record.tweet_url)) || cases.get(clean(record.image_dir));
    if (!item?.prompt) return [];
    const category = clean(record.category) || source.label;
    return [promptRecord(source, indexValue, {
      title: clean(record.title) || `GPT Image 2 案例 ${indexValue + 1}`,
      prompt: item.prompt,
      preview: item.image,
      category,
      tags: splitTags(category.replace(/\s+Cases$/i, ""), /\s*(?:&|and)\s*/i),
      created: normalizeDate(record.added_at),
      link: clean(record.tweet_url),
    })];
  });
}

function collectTigerCases(source: PromptMarketSourceConfig, markdown: string, cases: Map<string, { prompt: string; image: string }>) {
  const pattern = /### Case\s+\d+:\s+\[[^\]]+]\(([^)]+)\)([\s\S]*?)(?=\n### Case\s+\d+:|$)/g;
  for (const match of markdown.matchAll(pattern)) {
    const block = match[0];
    const prompt = firstMatch(block, /\*\*Prompt:\*\*\s*\r?\n\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```/i);
    if (!prompt) continue;
    const images = extractImages(source, block);
    const item = { prompt, image: images[0] || "" };
    cases.set(clean(match[1]), item);
    const imageDir = block.match(/images\/\w+_case\d+/)?.[0];
    if (imageDir) cases.set(imageDir, item);
  }
}

async function fetchZeroLuPrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  const markdown = await fetchText(sourceURL(source, "README.md"), signal);
  const result: BananaPrompt[] = [];
  splitBeforeHeading(markdown, "## ").forEach((section) => {
    const heading = firstMatch(section, /^##\s+(.+)$/m);
    const tags = splitTags(heading.replace(/[^\p{L}\p{N}/&、与 ]/gu, ""), /\s*(?:\/|&|、|与)\s*/);
    splitBeforeHeading(section, "### ").forEach((block) => {
      const rawTitle = firstMatch(block, /^###\s+(.+)$/m);
      const title = clean(rawTitle.replace(/\[([^\]]+)]\([^)]+\)/g, "$1"));
      const prompt = firstMatch(block, /\*\*Prompt:\*\*\s*\r?\n\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```/i);
      if (!title || !prompt) return;
      const images = extractImages(source, block);
      result.push(promptRecord(source, result.length, { title, prompt, preview: images[0] || "", category: heading || source.label, tags }));
    });
  });
  return result;
}

async function fetchImgEdifyPrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  const markdown = await fetchText(sourceURL(source, "README.zh-CN.md"), signal);
  const result: BananaPrompt[] = [];
  splitBeforeHeading(markdown, "### ").forEach((block) => {
    const title = firstMatch(block, /^###\s+(.+)$/m);
    const prompt = firstMatch(block, /-\s*\*\*提示词文本：\*\*\s*`([\s\S]*?)`/);
    if (!title || !prompt) return;
    const images = extractImages(source, block);
    result.push(promptRecord(source, result.length, { title, prompt, preview: images[0] || "", category: source.label, tags: ["gpt4o"] }));
  });
  return result;
}

async function fetchXianyuPrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  const [markdown, latest] = await Promise.all([
    fetchText(sourceURL(source, "README.md"), signal),
    fetchJSON<XianyuLatest>(sourceURL(source, "data/latest-prompts.json"), signal).catch(() => ({ dates: [], items: [] })),
  ]);
  const result = parseXianyuCollection(source, markdown);
  const seen = new Set<string>();
  const appendLatest = (item: XianyuLatestItem) => {
    const prompt = clean(item.prompt);
    if (!prompt) return;
    const key = firstNonEmpty(item.x_url, item.url, `${item.author || ""}${item.created_at || ""}${prompt}`);
    if (seen.has(key)) return;
    seen.add(key);
    const preview = firstNonEmpty(item.primary_image_url, ...(item.image_urls || []));
    result.push(promptRecord(source, result.length, { title: firstNonEmpty(item.reason, item.author, "X Prompt"), prompt, preview, category: "X 最新提示词", tags: ["x"], link: firstNonEmpty(item.x_url, item.url), created: normalizeDate(item.created_at) }));
  };
  (latest.dates || []).forEach((group) => (group.items || []).forEach(appendLatest));
  (latest.items || []).forEach(appendLatest);
  return result;
}

function parseXianyuCollection(source: PromptMarketSourceConfig, markdown: string) {
  const section = markdownSection(markdown, "## 提示词合集", "## 高级技巧");
  const result: BananaPrompt[] = [];
  let category = "";
  let title = "";
  let lines: string[] = [];
  const finish = () => {
    if (!title || category === "补充案例提示词") return;
    const block = lines.join("\n");
    const prompt = xianyuCodeBlock(block) || xianyuFallbackText(block);
    if (!prompt) return;
    const images = extractImages(source, block);
    result.push(promptRecord(source, result.length, { title, prompt, preview: images[0] || "", category: category || source.label, tags: ["gpt-image-2", ...splitTags(category, /\s*(?:\/|&|、|与)\s*/)] }));
  };
  section.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("### ") && !line.startsWith("#### ")) { finish(); category = cleanNumberedHeading(line.slice(4)); title = ""; lines = []; return; }
    if (line.startsWith("#### ")) { finish(); title = cleanNumberedHeading(line.slice(5)); lines = []; return; }
    if (title) lines.push(line);
  });
  finish();
  return result;
}

async function fetchYouMindPrompts(source: PromptMarketSourceConfig, modelTag: string, signal?: AbortSignal) {
  const markdown = await fetchText(sourceURL(source, "README_zh.md"), signal);
  const result: BananaPrompt[] = [];
  splitBeforeHeading(markdown, "### ").forEach((block) => {
    const title = firstMatch(block, /^###\s+No\.\s*\d+:\s*(.+)$/m);
    const prompt = firstMatch(block, /####\s+.*?提示词\s*\r?\n\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```/i);
    if (!title || !prompt) return;
    const images = extractImages(source, block);
    const headingTags = title.includes(" - ") ? splitTags(title.split(" - ")[0], /\s*(?:\/|&|、|与)\s*/) : [];
    result.push(promptRecord(source, result.length, { title, prompt, preview: images[0] || "", category: source.label, tags: [modelTag, ...headingTags] }));
  });
  return result;
}

async function fetchDavidWuPrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  const items = await fetchJSON<DavidWuPrompt[]>(sourceURL(source, "prompts.json"), signal);
  return items.flatMap((item, index) => {
    const title = firstNonEmpty(item.title_cn, item.title_en);
    const prompt = clean(item.prompt);
    if (!title || !prompt) return [];
    const preview = absoluteURL(source, clean(item.image));
    return [promptRecord(source, index, {
      title,
      prompt,
      preview,
      category: firstNonEmpty(item.category_cn, item.category, source.label),
      tags: [...splitTags([item.category_cn, item.category, item.author, item.source].filter(Boolean).join("/"), /\//), ...(item.needs_ref ? ["需要参考图"] : [])],
      author: clean(item.author),
    })];
  });
}

async function fetchFreestyleflyPrompts(source: PromptMarketSourceConfig, signal?: AbortSignal) {
  const data = await fetchJSON<FreestyleflyCollection>(sourceURL(source, "data/cases.json"), signal);
  return (data.cases || []).flatMap((item, index) => {
    const title = clean(item.title);
    const prompt = clean(item.prompt);
    if (!title || !prompt) return [];
    return [promptRecord(source, index, {
      title,
      prompt,
      preview: absoluteURL(source, clean(item.image)),
      category: clean(item.category) || source.label,
      tags: [
        ...((item.styles || []).map(clean)),
        ...((item.scenes || []).map(clean)),
        ...(item.featured ? ["精选"] : []),
      ],
      author: clean(item.sourceLabel),
      link: firstNonEmpty(item.sourceUrl, item.githubUrl),
    })];
  });
}

function promptRecord(source: PromptMarketSourceConfig, index: number, input: { title: string; prompt: string; preview: string; category: string; tags: string[]; author?: string; link?: string; created?: string }): BananaPrompt {
  const preview = clean(input.preview);
  const prompt = clean(input.prompt);
  const title = clean(input.title);
  const category = clean(input.category) || source.label;
  return {
    id: `${source.id}:${String(index + 1).padStart(4, "0")}`,
    title,
    preview: preview || EMPTY_PREVIEW,
    referenceImageUrls: [],
    prompt,
    author: clean(input.author) || source.label,
    ...(clean(input.link) ? { link: clean(input.link) } : {}),
    category,
    tags: Array.from(new Set(input.tags.map(clean).filter(Boolean))).slice(0, 24),
    ...(input.created ? { created: input.created } : {}),
    source: source.id,
    sourceLabel: source.label,
    isNsfw: NSFW_PATTERN.test(`${title}\n${category}\n${prompt}`),
  };
}

function sourceURL(source: PromptMarketSourceConfig, file: string) {
  return `${source.url.replace(/\/$/, "")}/${file.replace(/^\//, "")}`;
}

async function fetchText(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: "text/markdown,text/plain,application/json" } });
  if (!response.ok) throw new Error(`${url.split("/").pop() || "提示词源"} 拉取失败：${response.status}`);
  return response.text();
}

async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url.split("/").pop() || "提示词源"} 拉取失败：${response.status}`);
  return response.json() as Promise<T>;
}

function extractImages(source: PromptMarketSourceConfig, block: string) {
  const values = [...block.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>|!\[[^\]]*]\(([^)]+)\)/gi)].map((match) => absoluteURL(source, clean(match[1] || match[2]))).filter(Boolean);
  return Array.from(new Set(values));
}

function absoluteURL(source: PromptMarketSourceConfig, value: string) {
  if (!value || /^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
  const repositoryPath = value.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
  return sourceURL(source, repositoryPath);
}

function splitBeforeHeading(markdown: string, prefix: string) {
  const blocks: string[] = [];
  let current: string[] = [];
  markdown.split(/\r?\n/).forEach((line) => {
    if (line.startsWith(prefix) && current.length) { blocks.push(current.join("\n")); current = []; }
    current.push(line);
  });
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function markdownSection(markdown: string, startHeading: string, endHeading: string) {
  const start = markdown.indexOf(startHeading);
  if (start < 0) return "";
  const afterStart = start + startHeading.length;
  const end = markdown.indexOf(endHeading, afterStart);
  return end < 0 ? markdown.slice(start) : markdown.slice(start, end);
}

function xianyuCodeBlock(block: string) {
  return firstMatch(block, /```[\w-]*\r?\n([\s\S]*?)\r?\n```/);
}

function xianyuFallbackText(block: string) {
  return block.split(/\r?\n/).map(clean).filter((line) => line && !/^(?:#|---|!\[|\||>|```|https?:|[-*]\s*(?:原文链接|公众号|作者|本次补充|说明))/.test(line)).map((line) => line.replace(/^[-*]\s*/, "").replace(/^提示词：\s*/, "")).join("\n");
}

function cleanNumberedHeading(value: string) {
  return clean(value.replace(/^\s*[\d一二三四五六七八九十]+[、.．]\s*/, ""));
}

function firstMatch(value: string, pattern: RegExp) {
  return clean(value.match(pattern)?.[1]);
}

function splitTags(value: string, pattern: RegExp) {
  return value.split(pattern).map((tag) => clean(tag).toLowerCase()).filter(Boolean);
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map(clean).find(Boolean) || "";
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDate(value?: string) {
  const date = new Date(clean(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

type XianyuLatestItem = { x_url?: string; url?: string; author?: string; created_at?: string; prompt?: string; reason?: string; image_urls?: string[]; primary_image_url?: string };
type XianyuLatest = { dates?: Array<{ items?: XianyuLatestItem[] }>; items?: XianyuLatestItem[] };
type DavidWuPrompt = { title_en?: string; title_cn?: string; category?: string; category_cn?: string; prompt?: string; author?: string; source?: string; needs_ref?: boolean; image?: string };
type FreestyleflyCollection = {
  cases?: Array<{
    title?: string;
    prompt?: string;
    image?: string;
    category?: string;
    styles?: string[];
    scenes?: string[];
    featured?: boolean;
    sourceLabel?: string;
    sourceUrl?: string;
    githubUrl?: string;
  }>;
};

const EMPTY_PREVIEW = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
const NSFW_PATTERN = /\b(nsfw|nude|naked|lingerie|erotic|explicit|fetish|topless)\b|裸|色情|情色|内衣|私处|情趣/i;
