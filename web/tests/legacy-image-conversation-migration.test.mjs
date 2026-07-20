import test from "node:test";
import assert from "node:assert/strict";

import {
  legacyImageConversationMigrationMarkerKey,
  legacyImageConversationScope,
  legacyImageConversationStorageKey,
  legacyImageConversationResponseIds,
  isLegacyImageConversationGoneStatus,
  normalizeLegacyImageConversationItems,
  splitLegacyImageConversationItems,
  validateLegacyImageConversationItems,
} from "../src/lib/legacy-image-conversation-migration-pure.ts";

const session = {
  key: "token-a",
  role: "user",
  subjectId: "User-42",
  provider: "LinuxDo",
};

test("legacy migration keeps the original scoped key format and isolates markers", () => {
  assert.equal(legacyImageConversationScope(session), "LinuxDo:user:User-42");
  assert.equal(legacyImageConversationStorageKey(session), "items:LinuxDo:user:User-42");
  assert.match(legacyImageConversationMigrationMarkerKey(session), /^chatgpt2api:image-conversations-migration:v1:[0-9a-f]{8}$/);
  assert.notEqual(
    legacyImageConversationMigrationMarkerKey(session),
    legacyImageConversationMigrationMarkerKey({ ...session, subjectId: "User-43" }),
  );
});

test("legacy records normalize to unique non-empty ids without fabricating rows", () => {
  const normalized = normalizeLegacyImageConversationItems({
    items: [
      { id: "a", title: "old" },
      { id: "", title: "invalid" },
      null,
      { id: "a", title: "latest" },
      { title: "missing-id" },
    ],
  });
  assert.deepEqual(normalized, [{ id: "a", title: "latest" }]);
  assert.equal(validateLegacyImageConversationItems([{ id: "a" }]).valid, true);
  assert.equal(validateLegacyImageConversationItems([{ id: "a" }, { id: "a" }]).valid, false);
  assert.equal(validateLegacyImageConversationItems([{ title: "missing-id" }]).valid, false);
});

test("legacy batches respect both item count and byte limits", () => {
  const items = [
    { id: "a", payload: "1111" },
    { id: "b", payload: "2222" },
    { id: "c", payload: "3333" },
  ];
  const batches = splitLegacyImageConversationItems(items, 2, 20);
  assert.deepEqual(batches.flat().map((item) => item.id), ["a", "b", "c"]);
  assert.ok(batches.every((batch) => batch.length <= 2));
  assert.ok(batches.length >= 2);
});

test("migration confirmation accepts server items and explicit accepted/gone acknowledgements", () => {
  const response = {
    items: [{ id: "from-items" }],
    acknowledgements: [
      { id: "accepted", accepted: true },
      { id: "gone", gone: true },
      { id: "stale", accepted: false },
    ],
  };
  assert.deepEqual(
    [...legacyImageConversationResponseIds(response)].sort(),
    ["accepted", "from-items", "gone"],
  );
});

test("migration never treats an unconfirmed missing detail as a tombstone", () => {
  assert.equal(isLegacyImageConversationGoneStatus(404), false);
  assert.equal(isLegacyImageConversationGoneStatus(410), true);
});
