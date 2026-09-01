import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  ALL_MUTATIONS_SCOPE,
  ScopedMutationLifecycle,
} from "../src/lib/scoped-mutation-lifecycle.ts";

const cardSource = await readFile(
  new URL("../src/app/settings/components/video-model-contracts-card.tsx", import.meta.url),
  "utf8",
);

describe("video model contract mutation lifecycle", () => {
  test("parallel mutations for different contracts both remain applicable", () => {
    const tracker = new ScopedMutationLifecycle("account-a");
    const first = tracker.begin("contract-a");
    const second = tracker.begin("contract-b");

    expect(tracker.complete(second, true)).toEqual({
      current: true,
      applySnapshot: true,
      concurrent: true,
      reconcile: false,
    });
    expect(tracker.complete(first, true)).toEqual({
      current: true,
      applySnapshot: true,
      concurrent: true,
      reconcile: true,
    });
  });

  test("an older response for the same contract cannot replace the newer response", () => {
    const tracker = new ScopedMutationLifecycle("account-a");
    const older = tracker.begin("contract-a");
    const newer = tracker.begin("contract-a");

    expect(tracker.canApply(older)).toBe(false);
    expect(tracker.canApply(newer)).toBe(true);
    expect(tracker.complete(newer, true).applySnapshot).toBe(true);
    expect(tracker.complete(older, true)).toMatchObject({
      current: true,
      applySnapshot: false,
      reconcile: true,
    });
  });

  test("a global import conflicts with every overlapping contract mutation", () => {
    const tracker = new ScopedMutationLifecycle("account-a");
    const toggle = tracker.begin("contract-a");
    const jsonImport = tracker.begin(ALL_MUTATIONS_SCOPE);

    expect(tracker.complete(jsonImport, true).applySnapshot).toBe(true);
    expect(tracker.complete(toggle, true)).toMatchObject({
      applySnapshot: false,
      reconcile: true,
    });
  });

  test("responses from an inactive session are ignored", () => {
    const tracker = new ScopedMutationLifecycle("account-a");
    const previousSession = tracker.begin("contract-a");

    tracker.activateSession("account-b");

    expect(tracker.complete(previousSession, true)).toEqual({
      current: false,
      applySnapshot: false,
      concurrent: false,
      reconcile: false,
    });
  });

  test("unmount invalidates pending responses from the active session", () => {
    const tracker = new ScopedMutationLifecycle("account-a");
    const pending = tracker.begin("contract-a");

    tracker.deactivateSession("account-a");

    expect(tracker.complete(pending, true).current).toBe(false);
  });

  test("a failed mutation still reconciles the authoritative contract list", () => {
    const tracker = new ScopedMutationLifecycle("account-a");
    const failed = tracker.begin("contract-a");

    expect(tracker.complete(failed, false)).toMatchObject({
      current: true,
      applySnapshot: false,
      reconcile: true,
    });
  });

  test("a failed batch retries reconciliation after interrupting a previous reload", () => {
    const tracker = new ScopedMutationLifecycle("account-a");
    const firstBatch = tracker.begin("contract-a");
    expect(tracker.complete(firstBatch, true).reconcile).toBe(true);

    const interruptingBatch = tracker.begin("contract-b");
    expect(tracker.complete(interruptingBatch, false).reconcile).toBe(true);
  });

  test("the card releases reset loading and guards mutation validation writes", () => {
    expect(cardSource).toContain("const interruptedResetLoad = contractLoadResetRef.current");
    expect(cardSource).toContain("if (interruptedResetLoad) setIsLoading(false)");
    expect(cardSource).toContain("if (mutationTicket && !mutationTrackerRef.current!.canApply(mutationTicket)) return null");
    expect(cardSource).toContain("const payload = await validate(false, ticket)");
  });

  test("the parameter preview waits for each changed contract to be installed", () => {
    expect(cardSource).toContain("const [installedContract, setInstalledContract] = useState<VideoModelContract | null>(null)");
    expect(cardSource).toContain("setInstalledContract(contract)");
    expect(cardSource).toContain("{installedContract === contract ? (");
    expect(cardSource).not.toContain("const [isReady, setIsReady] = useState(false)");
  });

  test("JSON imports validate contract names before the review summary can trim them", () => {
    const validation = "typeof entry.contract.name !== \"string\" || entry.contract.name.trim() === \"\"";
    const unsafeCast = "contract: entry.contract as unknown as VideoModelContract";

    expect(cardSource).toContain(validation);
    expect(cardSource).toContain("导入文件中的契约名称必须是非空字符串");
    expect(cardSource.indexOf(validation)).toBeLessThan(cardSource.indexOf(unsafeCast));
  });
});
