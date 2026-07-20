import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyImageConversationMergeAcknowledgements,
  enqueueScopedWrite,
  imageConversationAcknowledgementsRequireRefresh,
  imageConversationOwnerScope,
  imageConversationScopeBinding,
  ImageConversationScopeChangedError,
  ImageConversationScopeFailureRegistry,
  ImageConversationSessionScopeCoordinator,
  isMatchingImageConversationMinimalAck,
  isRetryableImageConversationSaveError,
  runCurrentImageConversationScopeOperation,
} from "../src/store/image-conversation-session-scope.ts";

function session(overrides = {}) {
  return {
    key: "token-a",
    role: "user",
    subjectId: "newapi:42",
    username: "alice",
    name: "Alice",
    provider: "newapi",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("owner scope is stable across token rotation and isolated by subject", () => {
  const first = imageConversationOwnerScope(session());
  const rotated = imageConversationOwnerScope(session({ key: "token-rotated" }));
  const otherUser = imageConversationOwnerScope(session({ subjectId: "newapi:84" }));

  assert.equal(first, rotated);
  assert.notEqual(first, otherUser);
  assert.equal(imageConversationScopeBinding(session()).authorization, "Bearer token-a");
  assert.equal(imageConversationScopeBinding(null).authorization, "Bearer __no_auth_session__");
});

test("account switch rejects unsent old writes without blocking the new account", async () => {
  const coordinator = new ImageConversationSessionScopeCoordinator();
  const oldScope = coordinator.activate(imageConversationScopeBinding(session()));
  const oldRequestStarted = deferred();
  const finishOldRequest = deferred();
  const publishedScopes = [];
  const requestAuthorizations = [];

  const runningOldWrite = enqueueScopedWrite(
    oldScope.writes,
    () => runCurrentImageConversationScopeOperation(coordinator, oldScope, async () => {
      requestAuthorizations.push(oldScope.authorization);
      oldRequestStarted.resolve();
      await finishOldRequest.promise;
      if (coordinator.isCurrent(oldScope)) {
        publishedScopes.push(oldScope.ownerScope);
      }
      return oldScope.authorization;
    }),
  );
  await oldRequestStarted.promise;

  const unsentOldWrite = enqueueScopedWrite(oldScope.writes, async () => "must-not-run");
  const unsentRejection = assert.rejects(
    unsentOldWrite,
    (error) => error instanceof ImageConversationScopeChangedError,
  );

  const newScope = coordinator.activate(imageConversationScopeBinding(session({
    key: "token-b",
    subjectId: "newapi:84",
    username: "bob",
    name: "Bob",
  })));
  const newWrite = enqueueScopedWrite(newScope.writes, async () => newScope.authorization);

  assert.equal(await newWrite, "Bearer token-b");
  await unsentRejection;
  assert.equal(coordinator.isCurrent(oldScope), false);
  assert.equal(coordinator.isCurrent(newScope), true);

  const runningRejection = assert.rejects(
    runningOldWrite,
    (error) => error instanceof ImageConversationScopeChangedError,
  );
  finishOldRequest.resolve();
  await runningRejection;
  assert.deepEqual(requestAuthorizations, ["Bearer token-a"]);
  assert.deepEqual(publishedScopes, []);
});

test("a token change retires the previous lease even for the same owner", async () => {
  const coordinator = new ImageConversationSessionScopeCoordinator();
  const first = coordinator.activate(imageConversationScopeBinding(session()));
  const blocker = deferred();
  const running = enqueueScopedWrite(first.writes, async () => blocker.promise);
  await Promise.resolve();
  const pending = enqueueScopedWrite(first.writes, async () => undefined);
  const pendingRejection = assert.rejects(
    pending,
    (error) => error instanceof ImageConversationScopeChangedError,
  );

  const rotated = coordinator.activate(imageConversationScopeBinding(session({ key: "token-rotated" })));
  assert.notEqual(rotated, first);
  assert.equal(rotated.ownerScope, first.ownerScope);
  assert.equal(rotated.authorization, "Bearer token-rotated");
  await pendingRejection;

  blocker.resolve();
  await running;
});

test("minimal persistence acknowledgement must match id and revision", () => {
  const expected = { id: "conversation-1", revision: 7 };
  assert.equal(isMatchingImageConversationMinimalAck({
    accepted: true,
    id: "conversation-1",
    revision: 7,
  }, expected), true);
  assert.equal(isMatchingImageConversationMinimalAck({
    accepted: true,
    id: "conversation-2",
    revision: 7,
  }, expected), false);
  assert.equal(isMatchingImageConversationMinimalAck({
    accepted: true,
    id: "conversation-1",
    revision: 6,
  }, expected), false);
  assert.equal(isMatchingImageConversationMinimalAck({
    accepted: false,
    id: "conversation-1",
    revision: 7,
  }, expected), false);
  assert.equal(isMatchingImageConversationMinimalAck({
    accepted: true,
    id: "conversation-1",
  }, expected), false);
});

test("batch acknowledgements accept every matching id and revision", () => {
  const results = classifyImageConversationMergeAcknowledgements({
    acknowledgements: [
      { id: "conversation-1", accepted: true, gone: false, revision: 3 },
      { id: "conversation-2", accepted: true, gone: false, revision: 8 },
    ],
  }, [
    { id: "conversation-1", revision: 3 },
    { id: "conversation-2", revision: 8 },
  ]);

  assert.deepEqual(results.map(({ id, outcome, actualRevision }) => ({ id, outcome, actualRevision })), [
    { id: "conversation-1", outcome: "accepted", actualRevision: 3 },
    { id: "conversation-2", outcome: "accepted", actualRevision: 8 },
  ]);
  assert.equal(imageConversationAcknowledgementsRequireRefresh(results), false);
});

test("batch acknowledgements preserve success while classifying a stale item", () => {
  const results = classifyImageConversationMergeAcknowledgements({
    acknowledgements: [
      { id: "conversation-current", accepted: true, gone: false, revision: 4 },
      { id: "conversation-stale", accepted: false, gone: false, revision: 9 },
    ],
  }, [
    { id: "conversation-current", revision: 4 },
    { id: "conversation-stale", revision: 7 },
  ]);

  assert.equal(results[0].outcome, "accepted");
  assert.deepEqual(results[1], {
    id: "conversation-stale",
    expectedRevision: 7,
    actualRevision: 9,
    outcome: "stale",
    httpStatus: 409,
    code: "IMAGE_CONVERSATION_REVISION_STALE",
    message: "图片历史版本已过期: conversation-stale",
  });
});

test("batch acknowledgements classify a tombstoned conversation as gone", () => {
  const [result] = classifyImageConversationMergeAcknowledgements({
    acknowledgements: [
      { id: "conversation-gone", accepted: false, gone: true, revision: 0 },
    ],
  }, [{ id: "conversation-gone", revision: 5 }]);

  assert.equal(result.outcome, "gone");
  assert.equal(result.httpStatus, 410);
  assert.equal(result.code, "IMAGE_CONVERSATION_GONE");
});

test("batch acknowledgements reject missing items as protocol errors", () => {
  const results = classifyImageConversationMergeAcknowledgements({
    acknowledgements: [
      { id: "conversation-1", accepted: true, gone: false, revision: 2 },
    ],
  }, [
    { id: "conversation-1", revision: 2 },
    { id: "conversation-missing", revision: 6 },
  ]);

  assert.equal(results[0].outcome, "accepted");
  assert.equal(results[1].outcome, "protocol");
  assert.equal(results[1].httpStatus, 503);
  assert.equal(results[1].code, "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR");
  assert.equal(isRetryableImageConversationSaveError({ status: results[1].httpStatus }), true);
});

test("batch acknowledgements reject an accepted item with the wrong revision", () => {
  const [result] = classifyImageConversationMergeAcknowledgements({
    acknowledgements: [
      { id: "conversation-1", accepted: true, gone: false, revision: 12 },
    ],
  }, [{ id: "conversation-1", revision: 11 }]);

  assert.equal(result.outcome, "protocol");
  assert.equal(result.actualRevision, 12);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.code, "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR");
  assert.equal(isRetryableImageConversationSaveError({ status: result.httpStatus }), true);
});

test("a structured batch acknowledgement refreshes authoritative history even with no accepted item", () => {
  const response = {
    acknowledgements: [
      { id: "conversation-stale", accepted: false, gone: false, revision: 9 },
      { id: "conversation-gone", accepted: false, gone: true, revision: 0 },
    ],
  };
  const results = classifyImageConversationMergeAcknowledgements(response, [
    { id: "conversation-stale", revision: 7 },
    { id: "conversation-gone", revision: 5 },
  ]);

  assert.deepEqual(results.map((result) => result.outcome), ["stale", "gone"]);
  assert.equal(results.some((result) => result.outcome === "accepted"), false);
  assert.equal(imageConversationAcknowledgementsRequireRefresh(results), true);
});

test("conflict and tombstone responses are not retained for background retry", () => {
  assert.equal(isRetryableImageConversationSaveError({ status: 409 }), false);
  assert.equal(isRetryableImageConversationSaveError({ status: 410 }), false);
  assert.equal(isRetryableImageConversationSaveError({ status: 401 }), false);
  assert.equal(isRetryableImageConversationSaveError({ status: 429 }), true);
  assert.equal(isRetryableImageConversationSaveError({ status: 503 }), true);
  assert.equal(isRetryableImageConversationSaveError(new Error("network unavailable")), true);
});

test("a stale failure handle cannot discard state from the next account", () => {
  const coordinator = new ImageConversationSessionScopeCoordinator();
  const failures = new ImageConversationScopeFailureRegistry();
  const oldScope = coordinator.activate(imageConversationScopeBinding(session()));
  const oldFailure = failures.bind(oldScope, new Error("old write failed"));
  const newScope = coordinator.activate(imageConversationScopeBinding(session({
    key: "token-b",
    subjectId: "newapi:84",
  })));

  assert.equal(failures.scopeFor(oldFailure), oldScope);
  assert.notEqual(failures.scopeFor(oldFailure), newScope);
  assert.equal(coordinator.isCurrent(failures.scopeFor(oldFailure)), false);
});
