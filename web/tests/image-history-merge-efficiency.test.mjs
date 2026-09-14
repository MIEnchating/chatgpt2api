import assert from "node:assert/strict";
import test from "node:test";
import { mergeImageConversationSnapshot } from "../src/lib/image-task-state.ts";

test("large conversation merges preserve preferred order with linear identifier reads", () => {
  for (const incomingIsNewer of [true, false]) {
    let reads = 0;
    const turns = (start) => Array.from({ length: 800 }, (_, offset) => ({
      get id() { reads += 1; return `turn-${start + offset}`; },
      prompt: "test",
      images: [],
      status: "success",
    }));
    const previous = { id: "conversation", revision: 1, updatedAt: "2026-09-14T00:00:00Z", turns: turns(0) };
    const incoming = { ...previous, revision: incomingIsNewer ? 2 : 0, turns: turns(400) };
    const merged = mergeImageConversationSnapshot(previous, incoming);
    const ids = merged.turns.map((turn) => turn.id);
    assert.equal(ids.length, 1200);
    assert.equal(new Set(ids).size, 1200);
    assert.equal(ids[0], incomingIsNewer ? "turn-400" : "turn-0");
    assert.equal(ids.at(-1), incomingIsNewer ? "turn-399" : "turn-1199");
    assert.ok(reads < 20_000, `expected linear work, read ${reads} identifiers`);
  }
});
