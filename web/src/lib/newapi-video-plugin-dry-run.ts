import type { NewAPIVideoPluginResult } from "./api";

export type NewAPIVideoPluginDryRunResult = { checks: string[] };

type DryRunWorkerResult = { passed: boolean; checks: string[]; error?: string };

export async function dryRunNewAPIVideoPlugin(input: NewAPIVideoPluginResult, signal?: AbortSignal): Promise<NewAPIVideoPluginDryRunResult> {
  if (signal?.aborted) throw new DOMException("插件干跑已取消", "AbortError");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./newapi-video-plugin-dry-run.worker.ts", import.meta.url), { type: "module" });
    const timeout = setTimeout(() => {
      finish();
      reject(new Error("插件本地干跑超过 15 秒，已终止；请检查配置后重试"));
    }, 15_000);
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new DOMException("插件干跑已取消", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<DryRunWorkerResult>) => {
      finish();
      if (!event.data?.passed) {
        reject(new Error(event.data?.error || "插件本地干跑测试未通过"));
        return;
      }
      resolve({ checks: event.data.checks });
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "无法运行插件本地干跑测试"));
    };
    try { worker.postMessage(input); }
    catch (error) { finish(); reject(error); }
  });
}
