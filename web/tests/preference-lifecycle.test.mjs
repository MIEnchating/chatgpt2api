import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  dispatchImageGenerationPreferencesChanged,
  imageGenerationPreferencesFromChangedEvent,
  IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT,
} from "../src/lib/image-generation-preferences-events.ts";
import {
  IMAGE_GENERATION_PREFERENCES_RETRY_EVENT,
  requestImageGenerationPreferencesRetry,
} from "../src/lib/image-generation-preferences-retry.ts";
import { RelayTokenPreferenceMutationTracker } from "../src/lib/relay-token-preference-mutations.ts";
import { loadImageGenerationPreferences } from "../src/lib/use-image-generation-preferences.ts";

const retrySource = await readFile(
  new URL("../src/lib/image-generation-preferences-retry.ts", import.meta.url),
  "utf8",
);
const [imagePageSource, profilePageSource] = await Promise.all([
  readFile(new URL("../src/app/image/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/profile/page.tsx", import.meta.url), "utf8"),
]);

describe("preference lifecycle", () => {
  test("a failed preference read is not reported as authoritative", async () => {
    const result = await loadImageGenerationPreferences(async () => {
      throw new Error("database unavailable");
    });

    expect(result).toMatchObject({ status: "error" });
    expect(result.status === "error" && result.error.message).toBe("database unavailable");
    expect("preferences" in result).toBe(false);
  });

  test("a successful preference read is normalized before becoming ready", async () => {
    const result = await loadImageGenerationPreferences(async () => ({
      preferences: {
        api_mode: "images",
        default_image_model: "  image-model-a  ",
        workbench: { image_count: 30 },
      },
    }));

    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.preferences.default_image_model).toBe("image-model-a");
    expect(result.status === "ready" && result.preferences.workbench.image_count).toBe(10);
  });

  test("a mutation response from the previous session cannot become current", () => {
    const tracker = new RelayTokenPreferenceMutationTracker();
    tracker.activateSession("account-a");
    const accountAMutation = tracker.begin("image");

    tracker.activateSession("account-b");
    const accountBMutation = tracker.begin("image");

    expect(tracker.isCurrent(accountAMutation)).toBe(false);
    expect(tracker.isCurrent(accountBMutation)).toBe(true);
  });

  test("an older mutation in the same session cannot replace the latest choice", () => {
    const tracker = new RelayTokenPreferenceMutationTracker();
    tracker.activateSession("account-a");
    const older = tracker.begin("video");
    const latest = tracker.begin("video");

    expect(tracker.isCurrent(older)).toBe(false);
    expect(tracker.isCurrent(latest)).toBe(true);
  });

  test("one user retry action broadcasts to every preference consumer", () => {
    const target = new EventTarget();
    let retries = 0;
    target.addEventListener(IMAGE_GENERATION_PREFERENCES_RETRY_EVENT, () => {
      retries += 1;
    });

    requestImageGenerationPreferencesRetry(target);

    expect(retries).toBe(1);
  });

  test("preference load failures expose one persistent retry toast", () => {
    expect(retrySource).toContain('id: IMAGE_GENERATION_PREFERENCES_ERROR_TOAST_ID');
    expect(retrySource).toContain("duration: Infinity");
    expect(retrySource).toContain('label: "重试"');
    expect(retrySource).toContain("requestImageGenerationPreferencesRetry()");
  });

  test("preference change events are accepted only by the matching session", () => {
    const target = new EventTarget();
    let event;
    target.addEventListener(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT, (nextEvent) => {
      event = nextEvent;
    });

    expect(dispatchImageGenerationPreferencesChanged(
      "account-a",
      { default_image_model: "image-model-a" },
      target,
    )).toBe(true);
    expect(imageGenerationPreferencesFromChangedEvent(event, "account-a")).toMatchObject({
      default_image_model: "image-model-a",
    });
    expect(imageGenerationPreferencesFromChangedEvent(event, "account-b")).toBeNull();
  });

  test("empty sessions cannot emit or consume preference changes", () => {
    const target = new EventTarget();
    expect(dispatchImageGenerationPreferencesChanged("", {}, target)).toBe(false);
    expect(imageGenerationPreferencesFromChangedEvent(new CustomEvent(
      IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT,
      { detail: { preferences: {}, sessionKey: "account-a" } },
    ), "")).toBeNull();
  });

  test("every preference writer emits a session-scoped change", () => {
    expect(imagePageSource).toContain(
      "dispatchImageGenerationPreferencesChanged(persistenceSessionKey, preferences)",
    );
    expect(profilePageSource).toContain(
      "dispatchImageGenerationPreferencesChanged(saveSessionKey, saved)",
    );
    expect(imagePageSource).not.toContain(
      "new CustomEvent(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT",
    );
    expect(profilePageSource).not.toContain(
      "new CustomEvent(IMAGE_GENERATION_PREFERENCES_CHANGED_EVENT",
    );
  });

  test("workbench autosave verifies its session before and after the request", () => {
    expect(imagePageSource.match(/currentSessionKeyRef\.current !== persistenceSessionKey/g)).toHaveLength(2);
  });

  test("profile saves reject responses from a previous session", () => {
    expect(profilePageSource).toContain("currentSessionKeyRef.current !== saveSessionKey");
    expect(profilePageSource).toContain("<ProfileContent key={session.key} session={session} />");
  });
});
