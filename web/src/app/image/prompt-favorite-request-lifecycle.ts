export type PromptFavoriteRequestToken = Readonly<{
  lifecycle: number;
  revision: number;
}>;

export type PromptFavoriteLoadRequest = PromptFavoriteRequestToken & Readonly<{
  controller: AbortController;
}>;

export type PromptFavoriteMutationToken = PromptFavoriteRequestToken & Readonly<{
  invalidatedLoad: boolean;
}>;

export type PromptFavoriteMutationDecision = Readonly<{
  current: boolean;
  applySnapshot: boolean;
  reconcile: boolean;
}>;

const ignoredMutationDecision: PromptFavoriteMutationDecision = {
  current: false,
  applySnapshot: false,
  reconcile: false,
};

export class PromptFavoriteRequestLifecycle {
  private active = false;
  private lifecycle = 0;
  private revision = 0;
  private loadRequest: PromptFavoriteLoadRequest | null = null;
  private pendingMutations = new Set<number>();
  private mutationBatchNeedsReconcile = false;

  activate() {
    if (this.active) return;
    this.active = true;
    this.lifecycle += 1;
    this.revision += 1;
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.lifecycle += 1;
    this.revision += 1;
    this.abortLoad();
    this.pendingMutations.clear();
    this.mutationBatchNeedsReconcile = false;
  }

  beginLoad(): PromptFavoriteLoadRequest | null {
    if (!this.active) return null;

    this.abortLoad();
    this.revision += 1;
    const request = {
      lifecycle: this.lifecycle,
      revision: this.revision,
      controller: new AbortController(),
    };
    this.loadRequest = request;
    return request;
  }

  isCurrentLoad(request: PromptFavoriteLoadRequest) {
    return this.loadRequest === request
      && !request.controller.signal.aborted
      && this.isCurrent(request);
  }

  releaseLoad(request: PromptFavoriteLoadRequest) {
    if (this.loadRequest === request) this.loadRequest = null;
  }

  cancelLoad(request: PromptFavoriteLoadRequest) {
    if (this.loadRequest !== request) return;
    request.controller.abort();
    this.loadRequest = null;
  }

  beginMutation(): PromptFavoriteMutationToken | null {
    if (!this.active) return null;

    const invalidatedLoad = this.loadRequest !== null;
    this.abortLoad();
    this.revision += 1;
    if (this.pendingMutations.size > 0) this.mutationBatchNeedsReconcile = true;
    this.pendingMutations.add(this.revision);
    return {
      lifecycle: this.lifecycle,
      revision: this.revision,
      invalidatedLoad,
    };
  }

  completeMutation(token: PromptFavoriteMutationToken, successful: boolean): PromptFavoriteMutationDecision {
    if (!this.isCurrentLifecycle(token) || !this.pendingMutations.has(token.revision)) {
      return ignoredMutationDecision;
    }

    const latest = token.revision === this.revision;
    const applySnapshot = successful && latest;
    if (!latest || (!successful && token.invalidatedLoad)) {
      this.mutationBatchNeedsReconcile = true;
    }

    this.pendingMutations.delete(token.revision);
    const reconcile = this.pendingMutations.size === 0 && this.mutationBatchNeedsReconcile;
    if (this.pendingMutations.size === 0) this.mutationBatchNeedsReconcile = false;

    return {
      current: true,
      applySnapshot,
      reconcile,
    };
  }

  isCurrentLifecycle(token: PromptFavoriteRequestToken) {
    return this.active && token.lifecycle === this.lifecycle;
  }

  private isCurrent(token: PromptFavoriteRequestToken) {
    return this.isCurrentLifecycle(token) && token.revision === this.revision;
  }

  private abortLoad() {
    this.loadRequest?.controller.abort();
    this.loadRequest = null;
  }
}
