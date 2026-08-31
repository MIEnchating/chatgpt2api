export const ALL_VIDEO_MODEL_CONTRACTS_SCOPE = "*";

type MutationBatch = {
  id: number;
  pending: Set<number>;
  concurrent: boolean;
  latestSequence: number;
  latestGlobalSequence: number;
  latestSequenceByScope: Map<string, number>;
};

export type VideoModelContractMutationTicket = {
  sessionKey: string;
  sessionVersion: number;
  sequence: number;
  scope: string;
  batchID: number;
};

export type VideoModelContractMutationDecision = {
  current: boolean;
  applySnapshot: boolean;
  concurrent: boolean;
  reconcile: boolean;
};

const ignoredMutationDecision: VideoModelContractMutationDecision = {
  current: false,
  applySnapshot: false,
  concurrent: false,
  reconcile: false,
};

export class VideoModelContractMutationTracker {
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

  begin(scope: string): VideoModelContractMutationTicket {
    const normalizedScope = scope.trim() || ALL_VIDEO_MODEL_CONTRACTS_SCOPE;
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
    if (normalizedScope === ALL_VIDEO_MODEL_CONTRACTS_SCOPE) {
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

  isCurrent(ticket: VideoModelContractMutationTicket) {
    return this.sessionKey === ticket.sessionKey
      && this.sessionVersion === ticket.sessionVersion
      && this.batch?.id === ticket.batchID
      && this.batch.pending.has(ticket.sequence);
  }

  canApply(ticket: VideoModelContractMutationTicket) {
    if (!this.isCurrent(ticket) || !this.batch) return false;
    return ticket.scope === ALL_VIDEO_MODEL_CONTRACTS_SCOPE
      ? ticket.sequence === this.batch.latestSequence
      : ticket.sequence === this.batch.latestSequenceByScope.get(ticket.scope)
        && ticket.sequence > this.batch.latestGlobalSequence;
  }

  complete(ticket: VideoModelContractMutationTicket, successful: boolean): VideoModelContractMutationDecision {
    if (!this.isCurrent(ticket) || !this.batch) return ignoredMutationDecision;

    const batch = this.batch;
    const applySnapshot = successful && this.canApply(ticket);
    batch.pending.delete(ticket.sequence);

    const reconcile = batch.pending.size === 0;
    const decision = {
      current: true,
      applySnapshot,
      concurrent: batch.concurrent,
      reconcile,
    };

    if (batch.pending.size === 0) this.batch = null;
    return decision;
  }
}
