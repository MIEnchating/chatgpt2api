import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { selectPersistedAssets } from "../src/app/assets/asset-library.ts";

const persisted = [
  { id: "a", kind: "text", title: "A", content: "x", tags: ["manual-tag"], visibility: "private" },
  { id: "b", kind: "text", title: "B", content: "y", tags: [], visibility: "private" },
];

test("bulk mutations start from persisted records, not group-derived display labels", () => {
  // The page replaces tags with group names for display; those must never be written back.
  const displayed = [{ ...persisted[0], tags: ["group-name"] }];
  const selected = selectPersistedAssets(persisted, displayed);
  assert.deepEqual(selected.map((asset) => asset.id), ["a"]);
  assert.deepEqual(selected[0].tags, ["manual-tag"]);
});

test("targets without a persisted record are skipped", () => {
  assert.deepEqual(selectPersistedAssets(persisted, [{ ...persisted[0], id: "missing" }]), []);
});

test("assets page feeds persisted records into the bulk visibility update", () => {
  const source = readFileSync(new URL("../src/app/assets/page.tsx", import.meta.url), "utf8");
  assert.match(source, /selectPersistedAssets\(assets, targets\.filter/);
});
