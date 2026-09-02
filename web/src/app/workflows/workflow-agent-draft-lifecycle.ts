export type WorkflowAgentDraftRun<TResponse> = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  prepareReferences: (signal: AbortSignal) => Promise<string[]>;
  submit: (references: string[], signal: AbortSignal) => Promise<TResponse>;
  commit: (response: TResponse) => void;
};

export async function runCurrentWorkflowAgentDraft<TResponse>(
  run: WorkflowAgentDraftRun<TResponse>,
) {
  const isCurrent = () => !run.signal.aborted && run.isCurrent();
  if (!isCurrent()) return false;
  const references = await run.prepareReferences(run.signal);
  if (!isCurrent()) return false;
  const response = await run.submit(references, run.signal);
  if (!isCurrent()) return false;
  run.commit(response);
  return true;
}
