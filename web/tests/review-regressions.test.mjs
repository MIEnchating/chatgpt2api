import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [requestSource, canvasSource, agentRequestSource, imageSource, assetsSource] = await Promise.all([
  readFile(new URL("../src/lib/request.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/canvas/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/canvas/agent/canvas-agent-request.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/image/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/assets/page.tsx", import.meta.url), "utf8"),
]);

describe("review regressions", () => {
  test("ordinary API requests have a default timeout", () => {
    expect(requestSource).toContain("timeout: 30_000");
    expect(requestSource).toContain("timeout = 30_000");
  });

  test("canvas does not apply a workspace without model contracts", () => {
    expect(canvasSource).toContain("await Promise.all([fetchCanvasDocument(), fetchModelConfig()])");
    expect(canvasSource).not.toContain("const modelConfigRequest = fetchModelConfig().catch(() => undefined);");
    expect(canvasSource.indexOf("await Promise.all([fetchCanvasDocument(), fetchModelConfig()])")).toBeLessThan(canvasSource.indexOf("applyWorkspace(workspace);"));
  });

  test("creator model configuration failures stay non-authoritative and retryable", () => {
    expect(imageSource).toContain("setImageModelConfigError(error instanceof Error ? error.message : \"模型配置加载失败\")");
    expect(imageSource).toContain("setImageModelConfigReloadKey((value) => value + 1)");
    expect(imageSource).not.toMatch(/\.finally\(\(\) => \{[\s\S]{0,160}setImageModelConfigReady\(true\)/);
  });

  test("Agent timeout cancels its submitted server task", () => {
    const cancelAt = agentRequestSource.indexOf("await cancelCreationTask(submitted.id).catch(() => undefined);");
    const timeoutAt = agentRequestSource.indexOf('throw new CanvasAgentRequestError("Agent 请求超时")');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(timeoutAt);
  });

  test("managed assets expose loading, persistent error, and retry states", () => {
    expect(assetsSource).toContain("managedLoading");
    expect(assetsSource).toContain("managedError");
    expect(assetsSource).toContain("setManagedReloadKey((value) => value + 1)");
    expect(assetsSource).toContain("loading || visibleLoading || managedLoading");
  });
});
