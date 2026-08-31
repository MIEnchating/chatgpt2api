import { describe, expect, test } from "bun:test";

import {
  AnnouncementLoadLifecycle,
  loadAnnouncementSnapshot,
} from "../src/lib/announcement-lifecycle.ts";

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
});
