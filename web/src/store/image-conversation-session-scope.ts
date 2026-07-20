export type ImageConversationSessionIdentity = {
  key?: string | null;
  role?: string | null;
  subjectId?: string | null;
  username?: string | null;
  name?: string | null;
  provider?: string | null;
};

export type ImageConversationScopeBinding = {
  ownerScope: string;
  authorization: string;
};

export type ImageConversationMinimalAck = {
  accepted?: unknown;
  id?: unknown;
  revision?: unknown;
};

export type ImageConversationMergeAckResponse = ImageConversationMinimalAck & {
  acknowledgements?: unknown;
};

export type ImageConversationAcknowledgementResult = {
  id: string;
  expectedRevision?: number;
  actualRevision?: number;
  outcome: "accepted" | "stale" | "gone" | "protocol";
  httpStatus?: 409 | 410 | 503;
  code?:
    | "IMAGE_CONVERSATION_REVISION_STALE"
    | "IMAGE_CONVERSATION_GONE"
    | "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR";
  message?: string;
};

type ScopedWriteEntry<T> = {
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type UnknownScopedWriteEntry = ScopedWriteEntry<unknown>;

export type ScopedWriteQueue = {
  retired: boolean;
  running: boolean;
  entries: UnknownScopedWriteEntry[];
  idleWaiters: Array<() => void>;
};

export type ImageConversationSessionScope = ImageConversationScopeBinding & {
  id: number;
  retired: boolean;
  writes: ScopedWriteQueue;
};

function normalizedIdentityPart(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function opaqueKeyFallback(value: unknown) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function imageConversationOwnerScope(session: ImageConversationSessionIdentity | null) {
  if (!session) {
    return "anonymous";
  }
  const provider = normalizedIdentityPart(session.provider) || "local";
  const role = normalizedIdentityPart(session.role) || "unknown";
  const owner =
    normalizedIdentityPart(session.subjectId) ||
    normalizedIdentityPart(session.username) ||
    normalizedIdentityPart(session.name) ||
    `key-${opaqueKeyFallback(session.key)}`;
  return `${provider}:${role}:${owner}`;
}

export function imageConversationScopeBinding(
  session: ImageConversationSessionIdentity | null,
): ImageConversationScopeBinding {
  const token = String(session?.key || "").trim();
  return {
    ownerScope: imageConversationOwnerScope(session),
    authorization: token ? `Bearer ${token}` : "Bearer __no_auth_session__",
  };
}

export function isMatchingImageConversationMinimalAck(
  response: ImageConversationMinimalAck,
  expected: { id: string; revision?: number },
) {
  const expectedRevision = Number(expected.revision);
  const acknowledgedRevision = Number(response.revision);
  return response.accepted === true &&
    response.id === expected.id &&
    Number.isSafeInteger(expectedRevision) &&
    expectedRevision > 0 &&
    acknowledgedRevision === expectedRevision;
}

function acknowledgementRevision(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function protocolAcknowledgementResult(
  expected: { id: string; revision?: number },
  message: string,
  actualRevision?: number,
): ImageConversationAcknowledgementResult {
  return {
    id: expected.id,
    expectedRevision: acknowledgementRevision(expected.revision),
    actualRevision,
    outcome: "protocol",
    httpStatus: 503,
    code: "IMAGE_CONVERSATION_ACK_PROTOCOL_ERROR",
    message,
  };
}

function classifyImageConversationAcknowledgement(
  raw: unknown,
  expected: { id: string; revision?: number },
  requireGone: boolean,
): ImageConversationAcknowledgementResult {
  const expectedRevision = acknowledgementRevision(expected.revision);
  if (expectedRevision === undefined || expectedRevision <= 0) {
    return protocolAcknowledgementResult(
      expected,
      `图片历史缺少有效的预期版本: ${expected.id}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    return protocolAcknowledgementResult(
      expected,
      `图片历史确认响应格式无效: ${expected.id}`,
    );
  }

  const acknowledgement = raw as {
    accepted?: unknown;
    gone?: unknown;
    id?: unknown;
    revision?: unknown;
  };
  if (acknowledgement.id !== expected.id) {
    return protocolAcknowledgementResult(
      expected,
      `图片历史确认响应 ID 不匹配: ${expected.id}`,
    );
  }
  if (typeof acknowledgement.accepted !== "boolean") {
    return protocolAcknowledgementResult(
      expected,
      `图片历史确认响应缺少 accepted: ${expected.id}`,
    );
  }
  if (requireGone && typeof acknowledgement.gone !== "boolean") {
    return protocolAcknowledgementResult(
      expected,
      `图片历史确认响应缺少 gone: ${expected.id}`,
    );
  }
  const actualRevision = acknowledgementRevision(acknowledgement.revision);
  if (actualRevision === undefined) {
    return protocolAcknowledgementResult(
      expected,
      `图片历史确认响应缺少有效版本: ${expected.id}`,
    );
  }

  if (acknowledgement.gone === true) {
    if (acknowledgement.accepted) {
      return protocolAcknowledgementResult(
        expected,
        `图片历史确认响应状态冲突: ${expected.id}`,
        actualRevision,
      );
    }
    return {
      id: expected.id,
      expectedRevision,
      actualRevision,
      outcome: "gone",
      httpStatus: 410,
      code: "IMAGE_CONVERSATION_GONE",
      message: `图片历史已删除或清空: ${expected.id}`,
    };
  }
  if (!acknowledgement.accepted) {
    return {
      id: expected.id,
      expectedRevision,
      actualRevision,
      outcome: "stale",
      httpStatus: 409,
      code: "IMAGE_CONVERSATION_REVISION_STALE",
      message: `图片历史版本已过期: ${expected.id}`,
    };
  }
  if (actualRevision !== expectedRevision) {
    return protocolAcknowledgementResult(
      expected,
      `图片历史确认版本不匹配: ${expected.id}`,
      actualRevision,
    );
  }
  return {
    id: expected.id,
    expectedRevision,
    actualRevision,
    outcome: "accepted",
  };
}

export function classifyImageConversationMergeAcknowledgements(
  response: ImageConversationMergeAckResponse,
  expected: ReadonlyArray<{ id: string; revision?: number }>,
): ImageConversationAcknowledgementResult[] {
  if (expected.length === 0) {
    return [];
  }

  if (!Array.isArray(response.acknowledgements)) {
    if (expected.length === 1) {
      return [classifyImageConversationAcknowledgement(response, expected[0], false)];
    }
    return expected.map((item) =>
      protocolAcknowledgementResult(
        item,
        `图片历史批量确认响应缺少 acknowledgements: ${item.id}`,
      ));
  }

  const expectedCounts = new Map<string, number>();
  for (const item of expected) {
    expectedCounts.set(item.id, (expectedCounts.get(item.id) || 0) + 1);
  }
  const acknowledgementsByID = new Map<string, unknown[]>();
  for (const acknowledgement of response.acknowledgements) {
    if (!acknowledgement || typeof acknowledgement !== "object") {
      continue;
    }
    const id = (acknowledgement as { id?: unknown }).id;
    if (typeof id !== "string" || !expectedCounts.has(id)) {
      continue;
    }
    const matches = acknowledgementsByID.get(id) || [];
    matches.push(acknowledgement);
    acknowledgementsByID.set(id, matches);
  }

  return expected.map((item) => {
    if ((expectedCounts.get(item.id) || 0) > 1) {
      return protocolAcknowledgementResult(
        item,
        `图片历史批量请求包含重复 ID: ${item.id}`,
      );
    }
    const matches = acknowledgementsByID.get(item.id) || [];
    if (matches.length === 0) {
      return protocolAcknowledgementResult(
        item,
        `图片历史批量确认响应缺少会话: ${item.id}`,
      );
    }
    if (matches.length > 1) {
      return protocolAcknowledgementResult(
        item,
        `图片历史批量确认响应包含重复会话: ${item.id}`,
      );
    }
    return classifyImageConversationAcknowledgement(matches[0], item, true);
  });
}

export function imageConversationAcknowledgementsRequireRefresh(
  results: ReadonlyArray<ImageConversationAcknowledgementResult>,
) {
  return results.some((result) => result.outcome !== "accepted");
}

export function isRetryableImageConversationSaveError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  return !Number.isFinite(status) || status === 408 || status === 425 || status === 429 || status >= 500;
}

export class ImageConversationScopeChangedError extends Error {
  readonly code = "IMAGE_CONVERSATION_SCOPE_CHANGED";

  constructor() {
    super("登录账号已切换，旧账号的图片历史操作已取消");
    this.name = "ImageConversationScopeChangedError";
  }
}

export function isImageConversationScopeChangedError(error: unknown) {
  return error instanceof ImageConversationScopeChangedError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "IMAGE_CONVERSATION_SCOPE_CHANGED");
}

export function createScopedWriteQueue(): ScopedWriteQueue {
  return {
    retired: false,
    running: false,
    entries: [],
    idleWaiters: [],
  };
}

function resolveIdleWaiters(queue: ScopedWriteQueue) {
  if (queue.running || queue.entries.length > 0) {
    return;
  }
  const waiters = queue.idleWaiters.splice(0);
  for (const resolve of waiters) {
    resolve();
  }
}

function runNextScopedWrite(queue: ScopedWriteQueue) {
  if (queue.running || queue.retired) {
    resolveIdleWaiters(queue);
    return;
  }
  const entry = queue.entries.shift();
  if (!entry) {
    resolveIdleWaiters(queue);
    return;
  }
  queue.running = true;
  Promise.resolve()
    .then(entry.operation)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      queue.running = false;
      runNextScopedWrite(queue);
    });
}

export function enqueueScopedWrite<T>(queue: ScopedWriteQueue, operation: () => Promise<T>): Promise<T> {
  if (queue.retired) {
    return Promise.reject(new ImageConversationScopeChangedError());
  }
  return new Promise<T>((resolve, reject) => {
    queue.entries.push({ operation, resolve, reject } as UnknownScopedWriteEntry);
    runNextScopedWrite(queue);
  });
}

export function waitForScopedWrites(queue: ScopedWriteQueue) {
  if (!queue.running && queue.entries.length === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    queue.idleWaiters.push(resolve);
  });
}

export function retireScopedWriteQueue(queue: ScopedWriteQueue) {
  if (queue.retired) {
    return;
  }
  queue.retired = true;
  const error = new ImageConversationScopeChangedError();
  const entries = queue.entries.splice(0);
  for (const entry of entries) {
    entry.reject(error);
  }
  resolveIdleWaiters(queue);
}

export class ImageConversationSessionScopeCoordinator {
  private currentScope: ImageConversationSessionScope | null = null;
  private nextScopeId = 1;

  activate(binding: ImageConversationScopeBinding) {
    const current = this.currentScope;
    if (
      current &&
      !current.retired &&
      current.ownerScope === binding.ownerScope &&
      current.authorization === binding.authorization
    ) {
      return current;
    }
    this.invalidate();
    const scope: ImageConversationSessionScope = {
      ...binding,
      id: this.nextScopeId,
      retired: false,
      writes: createScopedWriteQueue(),
    };
    this.nextScopeId += 1;
    this.currentScope = scope;
    return scope;
  }

  invalidate() {
    const current = this.currentScope;
    this.currentScope = null;
    if (!current || current.retired) {
      return current;
    }
    current.retired = true;
    retireScopedWriteQueue(current.writes);
    return current;
  }

  isCurrent(scope: ImageConversationSessionScope) {
    return !scope.retired && this.currentScope === scope;
  }
}

export class ImageConversationScopeFailureRegistry {
  private readonly scopes = new WeakMap<object, ImageConversationSessionScope>();

  bind(scope: ImageConversationSessionScope, error: unknown) {
    const scopedError = typeof error === "object" && error !== null
      ? error
      : new Error(String(error || "图片历史写入失败"));
    this.scopes.set(scopedError, scope);
    return scopedError;
  }

  scopeFor(error: unknown) {
    return typeof error === "object" && error !== null
      ? this.scopes.get(error)
      : undefined;
  }
}

export async function runCurrentImageConversationScopeOperation<T>(
  coordinator: ImageConversationSessionScopeCoordinator,
  scope: ImageConversationSessionScope,
  operation: () => Promise<T>,
) {
  if (!coordinator.isCurrent(scope)) {
    throw new ImageConversationScopeChangedError();
  }
  const result = await operation();
  if (!coordinator.isCurrent(scope)) {
    throw new ImageConversationScopeChangedError();
  }
  return result;
}
