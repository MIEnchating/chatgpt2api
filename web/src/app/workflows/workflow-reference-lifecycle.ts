export type StoredWorkflowReference = {
  url: string;
  storageKey?: string;
  temporary?: boolean;
};

export type WorkflowReferenceOwner = {
  id: string;
  references?: readonly StoredWorkflowReference[];
  backend_task_ids: readonly string[];
};

export async function settleWorkflowReferenceUploads<T>(uploads: readonly Promise<T>[]) {
  const settled = await Promise.allSettled(uploads);
  return {
    uploaded: settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []),
    errors: settled.flatMap((item) => item.status === "rejected" ? [item.reason] : []),
  };
}

export function freezeWorkflowReferences<T extends StoredWorkflowReference>(
  references: readonly T[],
): T[] {
  return references.map((reference) => ({ ...reference }));
}

export function workflowReferenceCleanupKeys(
  discarded: readonly StoredWorkflowReference[],
  retained: readonly StoredWorkflowReference[],
) {
  const retainedKeys = new Set(retained.map((reference) => reference.storageKey).filter(Boolean));
  const retainedURLs = new Set(retained.map((reference) => reference.url).filter(Boolean));
  return Array.from(new Set(discarded.flatMap((reference) => {
    if (!reference.temporary || !reference.storageKey) return [];
    if (retainedKeys.has(reference.storageKey) || retainedURLs.has(reference.url)) return [];
    return [reference.storageKey];
  })));
}

export function ownedWorkflowTaskReferences(
  tasks: readonly WorkflowReferenceOwner[],
  inFlightTaskIDs: ReadonlySet<string>,
) {
  return tasks.flatMap((task) =>
    task.backend_task_ids.length || inFlightTaskIDs.has(task.id)
      ? task.references || []
      : []
  );
}
