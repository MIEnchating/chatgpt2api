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

type PromptSourcePullSchedule = {
  enabled: boolean;
  intervalMinutes: number;
};

const PULL_STATES_STORAGE_KEY = "chatgpt2api:prompt-source-pull-states:v1";
const PULL_LAST_RUN_STORAGE_KEY = "chatgpt2api:prompt-source-last-run:v1";
export const PROMPT_SOURCE_PULL_INTERVALS = [30, 60, 360, 1440] as const;

function readJSON(key: string): unknown {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Pull controls remain usable when browser storage is unavailable.
  }
}

function loadPullStates(): PullStateMap {
  const value = readJSON(PULL_STATES_STORAGE_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: PullStateMap = {};
  Object.entries(value as Record<string, unknown>).forEach(([id, item]) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const raw = item as Record<string, unknown>;
    if (raw.status !== "success" && raw.status !== "error") return;
    result[id] = {
      status: raw.status,
      ...(typeof raw.count === "number" && Number.isFinite(raw.count) ? { count: raw.count } : {}),
      ...(typeof raw.lastSuccess === "string" ? { lastSuccess: raw.lastSuccess } : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  });
  return result;
}

function loadLastPullAt() {
  const value = readJSON(PULL_LAST_RUN_STORAGE_KEY);
  return typeof value === "string" ? value : undefined;
}

export function usePromptSourcePulls(sources: PromptMarketSourceConfig[], schedule: PromptSourcePullSchedule) {
  const [states, setStates] = useState<PullStateMap>(() => loadPullStates());
  const [lastPullAt, setLastPullAt] = useState<string | undefined>(() => loadLastPullAt());
  const [isPullingAll, setIsPullingAll] = useState(false);
  const busySourceIDs = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());

  const updateStates = useCallback((update: (current: PullStateMap) => PullStateMap) => {
    setStates((current) => {
      const next = update(current);
      writeJSON(PULL_STATES_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const updateLastPullAt = useCallback((value: string) => {
    setLastPullAt(value);
    writeJSON(PULL_LAST_RUN_STORAGE_KEY, value);
  }, []);

  const pullSource = useCallback(async (source: PromptMarketSourceConfig, quiet = false): Promise<PromptSourcePullResult> => {
    if (busySourceIDs.current.has(source.id)) return { ok: false, skipped: true } as const;
    busySourceIDs.current.add(source.id);
    const controller = new AbortController();
    controllers.current.set(source.id, controller);
    updateStates((current) => ({
      ...current,
      [source.id]: { ...current[source.id], status: "pulling", error: undefined },
    }));

    try {
      const prompts = await fetchPromptMarketSourcePrompts(source, controller.signal);
      const lastSuccess = new Date().toISOString();
      updateStates((current) => ({
        ...current,
        [source.id]: { status: "success", count: prompts.length, lastSuccess },
      }));
      if (!quiet) toast.success(`${source.label} 拉取成功，共 ${prompts.length} 条`);
      return { ok: true, count: prompts.length, prompts };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, skipped: true } as const;
      const message = error instanceof Error ? error.message : "拉取失败";
      updateStates((current) => ({
        ...current,
        [source.id]: {
          ...current[source.id],
          status: "error",
          error: message,
        },
      }));
      if (!quiet) toast.error(`${source.label}：${message}`);
      return { ok: false, skipped: false } as const;
    } finally {
      busySourceIDs.current.delete(source.id);
      controllers.current.delete(source.id);
    }
  }, [updateStates]);

  const pullAll = useCallback(async (quiet = false) => {
    if (isPullingAll) return;
    const enabledSources = sources.filter((source) => source.enabled);
    if (enabledSources.length === 0) {
      if (!quiet) toast.info("没有已启用的提示词来源");
      return;
    }
    setIsPullingAll(true);
    try {
      const results = await Promise.all(enabledSources.map((source) => pullSource(source, true)));
      const succeeded = results.filter((result) => result.ok).length;
      const failed = results.filter((result) => !result.ok && !result.skipped).length;
      const lastPullAt = new Date().toISOString();
      updateLastPullAt(lastPullAt);
      if (!quiet) {
        if (failed > 0) toast.error(`拉取完成：${succeeded} 个成功，${failed} 个失败`);
        else toast.success(`已拉取 ${succeeded} 个提示词来源`);
      }
    } finally {
      setIsPullingAll(false);
    }
  }, [isPullingAll, pullSource, sources, updateLastPullAt]);

  const restartSchedule = useCallback(() => updateLastPullAt(new Date().toISOString()), [updateLastPullAt]);

  useEffect(() => {
    if (!schedule.enabled) return;
    const lastPullTime = Date.parse(lastPullAt || "");
    const nextPullTime = (Number.isFinite(lastPullTime) ? lastPullTime : Date.now()) + schedule.intervalMinutes * 60_000;
    const timeout = window.setTimeout(() => void pullAll(true), Math.max(0, nextPullTime - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [lastPullAt, pullAll, schedule.enabled, schedule.intervalMinutes]);

  useEffect(() => () => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    busySourceIDs.current.clear();
  }, []);

  return {
    states,
    lastPullAt,
    isPullingAll,
    pullSource,
    pullAll,
    restartSchedule,
  };
}
