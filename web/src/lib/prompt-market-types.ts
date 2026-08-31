export type BananaPromptMode = "generate" | "edit";
export type PromptMarketSourceId = string;
export type PromptMarketLanguage = "zh-CN" | "en";
export type PromptMarketSourceFormat =
  | "reference-project"
  | "banana-json"
  | "awesome-gpt-image-2-markdown"
  | "generic-json";

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
