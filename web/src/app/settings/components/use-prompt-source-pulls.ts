"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  fetchPromptMarketSourcePrompts,
  type BananaPrompt,
  type PromptMarketSourceConfig,
} from "@/app/image/banana-prompts";

type PromptSourcePullState = {
  status: "idle" | "pulling" | "success" | "error";
  count?: number;
  lastSuccess?: string;
  error?: string;
};

export type PromptSourcePullResult =
  | { ok: true; count: number; prompts: BananaPrompt[] }
  | { ok: false; skipped: boolean };

type PullStateMap = Record<string, PromptSourcePullState>;

export function usePromptSourcePulls(sources: PromptMarketSourceConfig[]) {
  const [states, setStates] = useState<PullStateMap>({});
  const [isPullingAll, setIsPullingAll] = useState(false);
  const busySourceIDs = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());

  const pullSource = useCallback(async (source: PromptMarketSourceConfig, quiet = false): Promise<PromptSourcePullResult> => {
    if (busySourceIDs.current.has(source.id)) return { ok: false, skipped: true } as const;
    busySourceIDs.current.add(source.id);
    const controller = new AbortController();
    controllers.current.set(source.id, controller);
    setStates((current) => ({
      ...current,
      [source.id]: { ...current[source.id], status: "pulling", error: undefined },
    }));

    try {
      const prompts = await fetchPromptMarketSourcePrompts(source, controller.signal);
      setStates((current) => ({
        ...current,
        [source.id]: {
          status: "success",
          count: prompts.length,
          lastSuccess: new Date().toISOString(),
        },
      }));
      if (!quiet) toast.success(`${source.label} 拉取成功，共 ${prompts.length} 条`);
      return { ok: true, count: prompts.length, prompts };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, skipped: true } as const;
      const message = error instanceof Error ? error.message : "拉取失败";
      setStates((current) => ({
        ...current,
        [source.id]: { ...current[source.id], status: "error", error: message },
      }));
      if (!quiet) toast.error(`${source.label}：${message}`);
      return { ok: false, skipped: false } as const;
    } finally {
      busySourceIDs.current.delete(source.id);
      controllers.current.delete(source.id);
    }
  }, []);

  const pullAll = useCallback(async () => {
    if (isPullingAll) return;
    const enabledSources = sources.filter((source) => source.enabled);
    if (enabledSources.length === 0) {
      toast.info("没有已启用的提示词来源");
      return;
    }
    setIsPullingAll(true);
    try {
      const results = await Promise.all(enabledSources.map((source) => pullSource(source, true)));
      const succeeded = results.filter((result) => result.ok).length;
      const failed = results.filter((result) => !result.ok && !result.skipped).length;
      if (failed > 0) toast.error(`拉取完成：${succeeded} 个成功，${failed} 个失败`);
      else toast.success(`已拉取 ${succeeded} 个提示词来源`);
    } finally {
      setIsPullingAll(false);
    }
  }, [isPullingAll, pullSource, sources]);

  useEffect(() => () => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    busySourceIDs.current.clear();
  }, []);

  return { states, isPullingAll, pullSource, pullAll };
}
