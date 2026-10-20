import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import contracts from "../../internal/protocol/video_model_contracts.json" with { type: "json" };
import { normalizeVideoTaskContractReference, resolveVideoTaskContracts, videoTaskContractReferencesEqual } from "../src/lib/video-task-contract.ts";

function managed(id, name, models, enabled = true, revision = 1) {
  return { id, enabled, revision, contract: { ...structuredClone(contracts.contracts[0]), name, models } };
}

test("historical task identity survives renames and newly matching model contracts", () => {
  const original = managed("original", "Renamed contract", ["old-video"], false, 5);
  const current = managed("current", "New route", ["grok-imagine-video"]);
  const used = { id: "original", name: "Original contract", driver: "xai-videos", revision: 2 };
  const result = resolveVideoTaskContracts([original, current], "grok-imagine-video", used);
  assert.equal(result.used.id, "original");
  assert.equal(result.current.id, "current");
  assert.equal(used.name, "Original contract");
  assert.equal(used.revision, 2);
});

test("missing task metadata is kept unknown while the current match remains editable", () => {
  const current = managed("current", "Current video contract", ["grok-imagine-video"]);
  const result = resolveVideoTaskContracts([current], "grok-imagine-video");
  assert.equal(result.used, undefined);
  assert.equal(result.current, current);
});

test("a deleted contract is never identified by reusing its old display name", () => {
  const replacement = managed("new-id", "Same name", ["grok-imagine-video"]);
  const result = resolveVideoTaskContracts([replacement], "grok-imagine-video", { id: "deleted-id", name: "Same name", revision: 1 });
  assert.equal(result.used, undefined);
  assert.equal(result.current.id, "new-id");
});

test("current contract selection uses enabled contracts and exact-over-wildcard precedence", () => {
  const broad = managed("broad", "Broad", ["grok-*"]);
  const exact = managed("exact", "Exact", ["grok-imagine-video"]);
  const disabled = managed("disabled", "Disabled", ["grok-imagine-video"], false);
  assert.equal(resolveVideoTaskContracts([disabled, broad, exact], "GROK-IMAGINE-VIDEO").current.id, "exact");
  assert.equal(resolveVideoTaskContracts([disabled, broad], "grok-imagine-video").current.id, "broad");
});

test("task contract normalization keeps only valid summary fields", () => {
  assert.equal(normalizeVideoTaskContractReference(null), undefined);
  assert.equal(normalizeVideoTaskContractReference({ name: " " }), undefined);
  assert.deepEqual(normalizeVideoTaskContractReference({ id: " contract ", name: " Video ", driver: "xai-videos", revision: 3, private: "hidden" }), {
    id: "contract", name: "Video", driver: "xai-videos", revision: 3,
  });
  assert.equal(normalizeVideoTaskContractReference({ name: "Video", revision: -1 }).revision, undefined);
});

test("task retries discard the previous task's contract reference", async () => {
  const page = await readFile(new URL("../src/app/image/page.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/taskRevision: undefined,/g) || []).length, (page.match(/taskRevision: undefined,\s+videoContract: undefined,/g) || []).length);
  assert.match(page, /videoContract: task\.video_contract/);
});

test("repeated task polls do not create history changes for an identical contract reference", () => {
  const used = { id: "contract", name: "Video", driver: "xai-videos", revision: 2 };
  assert.equal(videoTaskContractReferencesEqual(used, structuredClone(used)), true);
  assert.equal(videoTaskContractReferencesEqual(used, { ...used, revision: 3 }), false);
  assert.equal(videoTaskContractReferencesEqual(used, undefined), false);
});
