export const ALL_MUTATIONS_SCOPE = "*";

type MutationBatch = {
  id: number;
  pending: Set<number>;
  concurrent: boolean;
  latestSequence: number;
  latestGlobalSequence: number;
  latestSequenceByScope: Map<string, number>;
};

export type ScopedMutationToken = Readonly<{
  sessionKey: string;
  sessionVersion: number;
  sequence: number;
  scope: string;
  batchID: number;
}>;

export type ScopedMutationDecision = Readonly<{
  current: boolean;
  applySnapshot: boolean;
  concurrent: boolean;
  reconcile: boolean;
}>;

const ignoredMutationDecision: ScopedMutationDecision = {
  current: false,
  applySnapshot: false,
  concurrent: false,
  reconcile: false,
};

export class ScopedMutationLifecycle {
  private sessionKey: string;
  private sessionVersion = 1;
  private nextSequence = 0;
  private nextBatchID = 0;
  private batch: MutationBatch | null = null;

  constructor(sessionKey: string) {
    this.sessionKey = sessionKey;
  }

  activateSession(sessionKey: string) {
    if (this.sessionKey === sessionKey) return;
    this.sessionKey = sessionKey;
    this.sessionVersion += 1;
    this.batch = null;
  }

  deactivateSession(sessionKey: string) {
    if (this.sessionKey !== sessionKey) return;
    this.sessionKey = "";
    this.sessionVersion += 1;
    this.batch = null;
  }

  begin(scope: string): ScopedMutationToken {
    const normalizedScope = scope.trim() || ALL_MUTATIONS_SCOPE;
    const sequence = this.nextSequence + 1;
    this.nextSequence = sequence;

    if (!this.batch) {
      this.nextBatchID += 1;
      this.batch = {
        id: this.nextBatchID,
        pending: new Set(),
        concurrent: false,
        latestSequence: sequence,
        latestGlobalSequence: 0,
        latestSequenceByScope: new Map(),
      };
    } else {
      this.batch.concurrent = true;
      this.batch.latestSequence = sequence;
    }

    this.batch.pending.add(sequence);
    if (normalizedScope === ALL_MUTATIONS_SCOPE) {
      this.batch.latestGlobalSequence = sequence;
    } else {
      this.batch.latestSequenceByScope.set(normalizedScope, sequence);
    }

    return {
      sessionKey: this.sessionKey,
      sessionVersion: this.sessionVersion,
      sequence,
      scope: normalizedScope,
      batchID: this.batch.id,
    };
  }

  isCurrent(token: ScopedMutationToken) {
    return this.sessionKey === token.sessionKey
      && this.sessionVersion === token.sessionVersion
      && this.batch?.id === token.batchID
      && this.batch.pending.has(token.sequence);
  }

  canApply(token: ScopedMutationToken) {
    if (!this.isCurrent(token) || !this.batch) return false;
    return token.scope === ALL_MUTATIONS_SCOPE
      ? token.sequence === this.batch.latestSequence
      : token.sequence === this.batch.latestSequenceByScope.get(token.scope)
        && token.sequence > this.batch.latestGlobalSequence;
  }

  complete(token: ScopedMutationToken, successful: boolean): ScopedMutationDecision {
    if (!this.isCurrent(token) || !this.batch) return ignoredMutationDecision;

    const batch = this.batch;
    const applySnapshot = successful && this.canApply(token);
    batch.pending.delete(token.sequence);
    const decision = {
      current: true,
      applySnapshot,
      concurrent: batch.concurrent,
      reconcile: batch.pending.size === 0,
    };

    if (batch.pending.size === 0) this.batch = null;
    return decision;
  }
}

export function mergeScopedMutationItem<Item extends { id: string }>(
  current: Item[],
  item: Item,
  responseItems: Item[],
) {
  const next = current.some((candidate) => candidate.id === item.id)
    ? current.map((candidate) => candidate.id === item.id ? item : candidate)
    : [...current, item];
  const responseOrder = new Map(responseItems.map((candidate, index) => [candidate.id, index]));
  return next
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const leftOrder = responseOrder.get(left.candidate.id);
      const rightOrder = responseOrder.get(right.candidate.id);
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}
