import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  AnnouncementLoadLifecycle,
  loadAnnouncementSnapshot,
} from "../src/lib/announcement-lifecycle.ts";
import {
  mergeScopedMutationItem,
  ScopedMutationLifecycle,
} from "../src/lib/scoped-mutation-lifecycle.ts";

const [cardSource, settingsPageSource, apiSource] = await Promise.all([
  readFile(new URL("../src/app/settings/components/announcements-card.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/settings/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
]);

describe("announcement lifecycle", () => {
  test("requires both announcement and preference reads to succeed", async () => {
    await expect(loadAnnouncementSnapshot(
      async () => ({ items: [{ id: "announcement-a" }] }),
      async () => { throw new Error("preferences unavailable"); },
    )).rejects.toThrow("preferences unavailable");
  });

  test("a late response from the previous session cannot become successful", () => {
    const lifecycle = new AnnouncementLoadLifecycle("account-a");
    const accountALoad = lifecycle.beginLoad("account-a");

    lifecycle.activateSession("account-b");

    expect(lifecycle.completeLoad(accountALoad, 1_000)).toBe(false);
    expect(lifecycle.shouldLoad("account-b", 1_001, 5_000)).toBe(true);
  });

  test("only a successful current load starts the refresh interval", () => {
    const lifecycle = new AnnouncementLoadLifecycle("account-a");
    const load = lifecycle.beginLoad("account-a");

    expect(lifecycle.completeLoad(load, 1_000)).toBe(true);
    expect(lifecycle.shouldLoad("account-a", 2_000, 5_000)).toBe(false);
    expect(lifecycle.shouldLoad("account-a", 6_000, 5_000)).toBe(true);
  });

  test("automatic prompts are consumed once per successful session lifecycle", () => {
    const lifecycle = new AnnouncementLoadLifecycle("account-a");

    expect(lifecycle.consumeAutomaticPrompt("account-a")).toBe(true);
    expect(lifecycle.consumeAutomaticPrompt("account-a")).toBe(false);
    lifecycle.activateSession("account-b");
    expect(lifecycle.consumeAutomaticPrompt("account-b")).toBe(true);
  });

  test("parallel mutations for different announcements both remain applicable", () => {
    const lifecycle = new ScopedMutationLifecycle("account-a");
    const first = lifecycle.begin("announcement-a");
    const second = lifecycle.begin("announcement-b");

    expect(lifecycle.complete(second, true)).toEqual({
      current: true,
      applySnapshot: true,
      concurrent: true,
      reconcile: false,
    });
    expect(lifecycle.complete(first, true)).toEqual({
      current: true,
      applySnapshot: true,
      concurrent: true,
      reconcile: true,
    });
  });

  test("merging one concurrent response preserves newer state from another announcement", () => {
    const current = [
      { id: "announcement-a", enabled: false, version: "new-a" },
      { id: "announcement-b", enabled: false, version: "old-b" },
    ];
    const staleFullResponse = [
      { id: "announcement-a", enabled: true, version: "old-a" },
      { id: "announcement-b", enabled: true, version: "new-b" },
    ];

    expect(mergeScopedMutationItem(
      current,
      staleFullResponse[1],
      staleFullResponse,
    )).toEqual([
      { id: "announcement-a", enabled: false, version: "new-a" },
      { id: "announcement-b", enabled: true, version: "new-b" },
    ]);
  });

  test("an older mutation cannot replace a newer response for the same announcement", () => {
    const lifecycle = new ScopedMutationLifecycle("account-a");
    const older = lifecycle.begin("announcement-a");
    const newer = lifecycle.begin("announcement-a");

    expect(lifecycle.canApply(older)).toBe(false);
    expect(lifecycle.canApply(newer)).toBe(true);
    expect(lifecycle.complete(newer, true).applySnapshot).toBe(true);
    expect(lifecycle.complete(older, true)).toMatchObject({
      current: true,
      applySnapshot: false,
      reconcile: true,
    });
  });

  test("failed mutation batches still require an authoritative reload", () => {
    const lifecycle = new ScopedMutationLifecycle("account-a");
    const failed = lifecycle.begin("announcement-a");

    expect(lifecycle.complete(failed, false)).toMatchObject({
      current: true,
      applySnapshot: false,
      reconcile: true,
    });
  });

  test("mutation responses from an inactive session are ignored", () => {
    const lifecycle = new ScopedMutationLifecycle("account-a");
    const pending = lifecycle.begin("announcement-a");

    lifecycle.activateSession("account-b");

    expect(lifecycle.complete(pending, true)).toEqual({
      current: false,
      applySnapshot: false,
      concurrent: false,
      reconcile: false,
    });
  });

  test("the admin card binds loads and mutations to the active settings session", () => {
    expect(settingsPageSource).toContain("<AnnouncementsCard key={session.key} sessionKey={session.key} />");
    expect(apiSource).toContain("fetchAdminAnnouncements(options: { signal?: AbortSignal } = {})");
    expect(cardSource).toContain("fetchAdminAnnouncements({ signal: controller.signal })");
    expect(cardSource).toContain("mergeScopedMutationItem(items, data.item, data.items)");
    expect(cardSource).toContain("mutationLifecycleRef.current?.deactivateSession(sessionKey)");
    expect(cardSource).not.toContain("setItems(data.items)");
  });
});
