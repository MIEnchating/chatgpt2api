import type { NewAPIVideoPluginResult } from "./api";
import { runNewAPIVideoPluginDryRun, type GeneratedVideoPlugin } from "./newapi-video-plugin-checks";

type WorkerScope = {
  onmessage: ((event: MessageEvent<NewAPIVideoPluginResult>) => void) | null;
  postMessage: (result: { passed: boolean; checks: string[]; error?: string }) => void;
};
const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  void run(event.data).then(
    checks => scope.postMessage({ passed: true, checks }),
    (error: unknown) => scope.postMessage({ passed: false, checks: [], error: error instanceof Error ? error.message : "插件干跑测试失败" }),
  );
};

async function run(input: NewAPIVideoPluginResult) {
  // Only the server-generated module is loaded; provider requests are mocked.
  globalThis.fetch = (() => { throw new Error("dry-run blocked direct network access"); }) as typeof fetch;
  const moduleURL = URL.createObjectURL(new Blob([input.source], { type: "text/javascript;charset=utf-8" }));
  try {
    const plugin = await import(/* @vite-ignore */ moduleURL) as GeneratedVideoPlugin;
    return runNewAPIVideoPluginDryRun(plugin, input);
  } finally {
    URL.revokeObjectURL(moduleURL);
  }
}
