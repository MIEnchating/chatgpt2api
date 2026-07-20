import type { CreationTask, CreationTaskData } from "@/lib/api";
import type {
  ImageConversation,
  ImageTurn,
  ImageTurnStatus,
  StoredImage,
} from "@/store/image-conversations";

export type TaskStatus = CreationTask["status"];
export type TaskOutputStatus = NonNullable<CreationTask["output_statuses"]>[number];

const ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);
const TERMINAL_STATUSES = new Set<TaskStatus>(["success", "error", "cancelled"]);
export const MAX_CONCURRENT_CONVERSATION_QUEUE_RUNNERS = 3;

export function canStartImageConversationQueueRunner(
  activeConversationIds: ReadonlySet<string>,
  conversationId: string,
  limit = MAX_CONCURRENT_CONVERSATION_QUEUE_RUNNERS,
) {
  return (
    !activeConversationIds.has(conversationId) &&
    limit > 0 &&
    activeConversationIds.size < limit
  );
}

function statusRank(status: TaskStatus) {
  if (status === "success") {
    return 3;
  }
  if (status === "error" || status === "cancelled") {
    return 2;
  }
  if (status === "running") {
    return 1;
  }
  return 0;
}

function numericRevision(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function nextImageConversationRevision(...values: unknown[]) {
  const current = values.reduce<number>((highest, value) => {
    const revision = numericRevision(value);
    return revision === undefined ? highest : Math.max(highest, revision);
  }, 0);
  return current + 1;
}

function timestamp(value: unknown) {
  const text = String(value || "").trim();
  if (!text) {
    return Number.NaN;
  }
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) {
    return direct;
  }
  return Date.parse(text.replace(" ", "T"));
}

export function isTaskActive(status: TaskStatus) {
  return ACTIVE_STATUSES.has(status);
}

export function isTaskTerminal(status: TaskStatus) {
  return TERMINAL_STATUSES.has(status);
}

export function canDispatchImageTurn(input: {
  pageActive: boolean;
  sessionCurrent: boolean;
  conversationDeleted: boolean;
  turnCancelled: boolean;
  conversation: ImageConversation | null | undefined;
  turnId: string;
  taskIds?: string[];
}) {
  if (
    !input.pageActive ||
    !input.sessionCurrent ||
    input.conversationDeleted ||
    input.turnCancelled
  ) {
    return false;
  }
  const turn = input.conversation?.turns.find((item) => item.id === input.turnId);
  if (!turn || (turn.status !== "queued" && turn.status !== "generating")) {
    return false;
  }
  const loadingTaskIds = new Set(
    turn.images.flatMap((image) =>
      image.status === "loading" && (image.taskId || image.id)
        ? [image.taskId || image.id]
        : [],
    ),
  );
  if (loadingTaskIds.size === 0) {
    return false;
  }
  return (input.taskIds || []).every((taskId) => loadingTaskIds.has(taskId));
}

/**
 * Explicit per-output state is authoritative. Older servers may omit the
 * array, in which case the task-level state remains the compatibility fallback.
 */
export function effectiveTaskOutputStatus(
  taskStatus: TaskStatus,
  outputStatus?: TaskOutputStatus,
  outputCount?: number,
): TaskOutputStatus {
  // Older task snapshots could publish the task-level transition before the
  // only output slot. A single running task cannot still be waiting behind
  // itself, so reconcile that legacy half-state on the client.
  if (taskStatus === "running" && outputStatus === "queued" && outputCount === 1) {
    return "running";
  }
  if (outputStatus) {
    return outputStatus;
  }
  return taskStatus;
}

export function effectiveStoredImageLoadingPhase(
  image: StoredImage,
  context?: { images?: StoredImage[]; status?: unknown },
): "queued" | "running" | "idle" {
  if (image.status !== "loading") {
    return "idle";
  }
  if (image.taskStatus === "running") {
    return "running";
  }

  const images = context?.images || [];
  if (context?.status === "generating" && images.length === 1 && images[0] === image) {
    return "running";
  }
  return "queued";
}

export function hasTaskOutput(item: CreationTaskData | undefined) {
  return Boolean(item?.b64_json || item?.url || item?.text_response);
}

export function taskDataIsPreview(item: CreationTaskData | undefined) {
  return (item as (CreationTaskData & { preview?: unknown }) | undefined)?.preview === true;
}

export function hasFinalTaskOutput(item: CreationTaskData | undefined): item is CreationTaskData {
  return hasTaskOutput(item) && !taskDataIsPreview(item);
}

/**
 * An active task can finish output slots independently. Preview data remains
 * active, while final data with a successful slot status is immediately usable.
 */
export function effectiveTaskSlotStatus(
  taskStatus: TaskStatus,
  outputStatus: TaskOutputStatus | undefined,
  data: CreationTaskData | undefined,
  outputCount?: number,
): TaskOutputStatus {
  const status = effectiveTaskOutputStatus(taskStatus, outputStatus, outputCount);
  if (!isTaskActive(taskStatus) || status === "error" || status === "cancelled") {
    return status;
  }
  if (status === "success" && hasFinalTaskOutput(data)) {
    return "success";
  }
  if (status === "success") {
    return taskStatus === "queued" ? "queued" : "running";
  }
  return status;
}

export function taskSnapshotIsOlder(previous: CreationTask, incoming: CreationTask) {
  if (previous.id !== incoming.id) {
    return false;
  }

  // A task is terminal forever. A late active response must never reopen it.
  if (isTaskTerminal(previous.status) && isTaskActive(incoming.status)) {
    return true;
  }
  if (isTaskActive(previous.status) && isTaskTerminal(incoming.status)) {
    return false;
  }
  if (previous.status === "success" && incoming.status !== "success") {
    return true;
  }
  if (incoming.status === "success" && previous.status !== "success") {
    return false;
  }

  const previousRevision = numericRevision(previous.revision);
  const incomingRevision = numericRevision(incoming.revision);
  if (previousRevision !== undefined && incomingRevision !== undefined && previousRevision !== incomingRevision) {
    return incomingRevision < previousRevision;
  }

  const previousTime = timestamp(previous.updated_at);
  const incomingTime = timestamp(incoming.updated_at);
  if (Number.isFinite(previousTime) && Number.isFinite(incomingTime) && previousTime !== incomingTime) {
    return incomingTime < previousTime;
  }

  return statusRank(incoming.status) < statusRank(previous.status);
}

function mergeDataItem(previous: CreationTaskData | undefined, incoming: CreationTaskData | undefined) {
  if (!previous) {
    return incoming;
  }
  if (!incoming) {
    return previous;
  }
  if (hasFinalTaskOutput(previous) && !hasFinalTaskOutput(incoming)) {
    return previous;
  }
  if (!hasTaskOutput(incoming) && hasTaskOutput(previous)) {
    return previous;
  }
  const merged = { ...previous, ...incoming } as CreationTaskData & { preview?: unknown };
  if (hasFinalTaskOutput(incoming)) {
    delete merged.preview;
    if (incoming.url && !incoming.b64_json) {
      delete merged.b64_json;
    }
    if (incoming.b64_json && !incoming.url) {
      delete merged.url;
    }
    if (incoming.text_response) {
      delete merged.b64_json;
      delete merged.url;
    }
  }
  return merged;
}

export function mergeTaskData(previous: CreationTaskData[] | undefined, incoming: CreationTaskData[] | undefined) {
  const previousItems = previous || [];
  const incomingItems = incoming || [];
  const length = Math.max(previousItems.length, incomingItems.length);
  if (length === 0) {
    return undefined;
  }
  return Array.from({ length }, (_, index) => mergeDataItem(previousItems[index], incomingItems[index]) || {});
}

export function mergeTaskOutputStatuses(
  previous: CreationTask["output_statuses"],
  incoming: CreationTask["output_statuses"],
  taskStatus: TaskStatus,
) {
  const previousItems = previous || [];
  const incomingItems = incoming || [];
  const length = Math.max(previousItems.length, incomingItems.length);
  if (length === 0) {
    return undefined;
  }
  return Array.from({ length }, (_, index) => {
    const oldStatus = previousItems[index];
    const nextStatus = incomingItems[index];
    if (!oldStatus) {
      return nextStatus || "queued";
    }
    if (!nextStatus) {
      return oldStatus;
    }
    if (oldStatus === "success" && nextStatus !== "success") {
      return oldStatus;
    }
    if (statusRank(oldStatus) >= 2 && statusRank(nextStatus) < 2) {
      return oldStatus;
    }
    if (statusRank(nextStatus) >= 2 || taskStatus === "success" || taskStatus === "error" || taskStatus === "cancelled") {
      return nextStatus;
    }
    return statusRank(nextStatus) >= statusRank(oldStatus) ? nextStatus : oldStatus;
  });
}

export function mergeCreationTaskSnapshot(previous: CreationTask | undefined, incoming: CreationTask): CreationTask {
  if (!previous || previous.id !== incoming.id) {
    return incoming;
  }
  if (taskSnapshotIsOlder(previous, incoming)) {
    return previous;
  }
  if (isTaskTerminal(incoming.status)) {
    return {
      ...previous,
      ...incoming,
      data: incoming.data?.map((item) => ({ ...item })),
      output_statuses: incoming.output_statuses ? [...incoming.output_statuses] : undefined,
    };
  }
  return {
    ...previous,
    ...incoming,
    data: mergeTaskData(previous.data, incoming.data),
    output_statuses: mergeTaskOutputStatuses(previous.output_statuses, incoming.output_statuses, incoming.status),
  };
}

export function mergeCreationTaskList(tasks: CreationTask[]) {
  const merged = new Map<string, CreationTask>();
  for (const task of tasks) {
    const previous = merged.get(task.id);
    merged.set(task.id, mergeCreationTaskSnapshot(previous, task));
  }
  return [...merged.values()];
}

export function taskImageHasPreview(image: StoredImage) {
  return Boolean(image.b64_json || image.url || image.path);
}

function storedImageIsTerminal(image: StoredImage) {
  return (
    image.status === "success" ||
    image.status === "error" ||
    image.status === "cancelled" ||
    image.status === "message" ||
    image.taskStatus === "success" ||
    image.taskStatus === "error" ||
    image.taskStatus === "cancelled"
  );
}

function storedImageHasSuccessEvidence(image: StoredImage) {
  return (
    image.status === "success" ||
    image.status === "message" ||
    image.taskStatus === "success" ||
    taskImageHasPreview(image) ||
    Boolean(image.text_response)
  );
}

function storedImageTaskStartedAt(image: StoredImage) {
  return timestamp(image.taskCreatedAt);
}

function sameStoredImageTask(previous: StoredImage, incoming: StoredImage) {
  return !previous.taskId || !incoming.taskId || previous.taskId === incoming.taskId;
}

function incomingStartsLaterTask(previous: StoredImage, incoming: StoredImage) {
  if (!previous.taskId || !incoming.taskId || previous.taskId === incoming.taskId) {
    return false;
  }
  const previousStartedAt = storedImageTaskStartedAt(previous);
  const incomingStartedAt = storedImageTaskStartedAt(incoming);
  return Number.isFinite(previousStartedAt) && Number.isFinite(incomingStartedAt)
    ? incomingStartedAt > previousStartedAt
    : undefined;
}

export function mergeStoredImageSnapshot(
  previous: StoredImage,
  incoming: StoredImage,
  preferIncoming: boolean,
): StoredImage {
  const incomingIsLaterTask = incomingStartsLaterTask(previous, incoming);
  if (!sameStoredImageTask(previous, incoming)) {
    if (incomingIsLaterTask === true) {
      return incoming;
    }
    if (incomingIsLaterTask === false) {
      return previous;
    }
    return preferIncoming ? incoming : previous;
  }

  const previousTerminal = storedImageIsTerminal(previous);
  const incomingTerminal = storedImageIsTerminal(incoming);
  if (previousTerminal && !incomingTerminal) {
    return previous;
  }
  if (!previousTerminal && incomingTerminal) {
    return incoming;
  }
  if (previousTerminal && incomingTerminal) {
    const previousSuccess = storedImageHasSuccessEvidence(previous);
    const incomingSuccess = storedImageHasSuccessEvidence(incoming);
    if (previousSuccess !== incomingSuccess) {
      return incomingSuccess ? incoming : previous;
    }
  }

  const previousRevision = numericRevision(previous.taskRevision);
  const incomingRevision = numericRevision(incoming.taskRevision);
  if (previousRevision !== undefined && incomingRevision !== undefined && previousRevision !== incomingRevision) {
    return incomingRevision > previousRevision ? incoming : previous;
  }
  return preferIncoming ? incoming : previous;
}

function deriveMergedTurnStatus(images: StoredImage[], fallback: ImageTurnStatus): ImageTurnStatus {
  const loadingImages = images.filter((image) => image.status === "loading");
  if (loadingImages.some((image) => image.taskStatus === "running")) {
    return "generating";
  }
  if (loadingImages.length > 0) {
    return "queued";
  }
  if (images.some((image) => image.status === "error")) {
    return "error";
  }
  if (images.some((image) => image.status === "cancelled")) {
    return "cancelled";
  }
  if (images.some((image) => image.status === "success")) {
    return "success";
  }
  if (images.some((image) => image.status === "message")) {
    return "message";
  }
  return fallback;
}

function mergeImageTurnSnapshot(previous: ImageTurn, incoming: ImageTurn, preferIncoming: boolean): ImageTurn {
  const preferred = preferIncoming ? incoming : previous;
  const fallback = preferIncoming ? previous : incoming;
  const previousImages = new Map(previous.images.map((image) => [image.id, image]));
  const incomingImages = new Map(incoming.images.map((image) => [image.id, image]));
  // A non-empty newer image list is a replacement (for example, full-turn
  // regeneration). Only an empty list may be filled from the older snapshot.
  const imageIDs = (preferred.images.length > 0 ? preferred.images : fallback.images)
    .map((image) => image.id);
  const images = imageIDs.flatMap((id) => {
    const previousImage = previousImages.get(id);
    const incomingImage = incomingImages.get(id);
    if (previousImage && incomingImage) {
      return [mergeStoredImageSnapshot(previousImage, incomingImage, preferIncoming)];
    }
    return previousImage ? [previousImage] : incomingImage ? [incomingImage] : [];
  });
  const status = deriveMergedTurnStatus(images, preferred.status);
  return {
    ...fallback,
    ...preferred,
    images,
    status,
    error: status === "success" || status === "message" || status === "queued" || status === "generating"
      ? undefined
      : preferred.error || fallback.error,
  };
}

function conversationPrefersIncoming(previous: ImageConversation, incoming: ImageConversation) {
  const previousSummaryOnly = previous.historySummaryOnly === true;
  const incomingSummaryOnly = incoming.historySummaryOnly === true;
  if (previousSummaryOnly !== incomingSummaryOnly) {
    const summary = incomingSummaryOnly ? incoming : previous;
    const full = incomingSummaryOnly ? previous : incoming;
    const summaryRevision = numericRevision(summary.revision) || 0;
    const fullRevision = numericRevision(full.revision) || 0;
    if (summaryRevision !== fullRevision) {
      return incomingSummaryOnly
        ? summaryRevision > fullRevision
        : summaryRevision < fullRevision;
    }
    // At an equal explicit revision the full snapshot is authoritative. This
    // is the usual page + active/detail race and prevents an empty summary row
    // from erasing turns that were already loaded.
    if (summaryRevision > 0 && fullRevision > 0) {
      return !incomingSummaryOnly;
    }
    const summaryUpdatedAt = timestamp(summary.updatedAt);
    const fullUpdatedAt = timestamp(full.updatedAt);
    const summaryIsNewer = Number.isFinite(summaryUpdatedAt) &&
      Number.isFinite(fullUpdatedAt) &&
      summaryUpdatedAt > fullUpdatedAt;
    return incomingSummaryOnly ? summaryIsNewer : !summaryIsNewer;
  }
  const previousRevision = numericRevision(previous.revision) || 0;
  const incomingRevision = numericRevision(incoming.revision) || 0;
  if (previousRevision !== incomingRevision) {
    return incomingRevision > previousRevision;
  }
  const previousUpdatedAt = timestamp(previous.updatedAt);
  const incomingUpdatedAt = timestamp(incoming.updatedAt);
  if (Number.isFinite(previousUpdatedAt) && Number.isFinite(incomingUpdatedAt)) {
    return incomingUpdatedAt >= previousUpdatedAt;
  }
  return true;
}

export function mergeImageConversationSnapshot(
  previous: ImageConversation,
  incoming: ImageConversation,
): ImageConversation {
  const preferIncoming = conversationPrefersIncoming(previous, incoming);
  const preferred = preferIncoming ? incoming : previous;
  const fallback = preferIncoming ? previous : incoming;
  const turns = preferred.historySummaryOnly === true
    ? []
    : (() => {
        const previousTurns = new Map(previous.turns.map((turn) => [turn.id, turn]));
        const incomingTurns = new Map(incoming.turns.map((turn) => [turn.id, turn]));
        const turnIDs = [
          ...preferred.turns.map((turn) => turn.id),
          ...fallback.turns.map((turn) => turn.id).filter((id) => !preferred.turns.some((turn) => turn.id === id)),
        ];
        return turnIDs.flatMap((id) => {
          const previousTurn = previousTurns.get(id);
          const incomingTurn = incomingTurns.get(id);
          if (previousTurn && incomingTurn) {
            return [mergeImageTurnSnapshot(previousTurn, incomingTurn, preferIncoming)];
          }
          return previousTurn ? [previousTurn] : incomingTurn ? [incomingTurn] : [];
        });
      })();
  const mixedSummaryState =
    (previous.historySummaryOnly === true) !== (incoming.historySummaryOnly === true);
  return {
    ...fallback,
    ...preferred,
    revision: Math.max(Number(previous.revision || 0), Number(incoming.revision || 0)) || undefined,
    updatedAt: mixedSummaryState
      ? preferred.updatedAt || fallback.updatedAt
      : timestamp(incoming.updatedAt) >= timestamp(previous.updatedAt)
        ? incoming.updatedAt
        : previous.updatedAt,
    turns,
    ...(preferred.historySummaryOnly === true
      ? {
          historySummaryOnly: true,
          historySummary:
            preferred.historySummary || fallback.historySummary || {
              turnCount: turns.length,
              queued: 0,
              running: 0,
            },
        }
      : {
          historySummaryOnly: undefined,
          historySummary: undefined,
        }),
  };
}

/**
 * Rebase a pending conversation on the authoritative snapshot returned after
 * a revision conflict. Keeping this operation pure makes every persistence
 * path (durable, batch, and coalesced) use identical turn-merge semantics.
 */
export function rebaseImageConversationSnapshot(
  remote: ImageConversation,
  pending: ImageConversation,
  updatedAt = new Date().toISOString(),
): ImageConversation {
  const merged = mergeImageConversationSnapshot(remote, pending);
  return {
    ...merged,
    revision: nextImageConversationRevision(remote.revision, pending.revision),
    updatedAt,
  };
}

export function mergeImageConversationLists(
  previous: ImageConversation[],
  incoming: ImageConversation[],
  preserveMissingPrevious = false,
) {
  const previousByID = new Map(previous.map((conversation) => [conversation.id, conversation]));
  const incomingIDs = new Set(incoming.map((conversation) => conversation.id));
  const merged = incoming.map((conversation) => {
    const previousConversation = previousByID.get(conversation.id);
    return previousConversation
      ? mergeImageConversationSnapshot(previousConversation, conversation)
      : conversation;
  });
  if (preserveMissingPrevious) {
    merged.push(...previous.filter((conversation) => !incomingIDs.has(conversation.id)));
  }
  return merged.sort((left, right) => {
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    return updated !== 0 ? updated : right.id.localeCompare(left.id);
  });
}
