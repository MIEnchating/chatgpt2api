type ImageConversationSourceLike = {
  id?: unknown;
  turns?: Array<{
    source?: unknown;
    workflowTaskId?: unknown;
  }>;
};

export function isWorkflowImageConversation(conversation: ImageConversationSourceLike) {
  if (String(conversation.id || "").startsWith("workflow-")) return true;
  return Array.isArray(conversation.turns) && conversation.turns.some((turn) =>
    turn.source === "workflow" || Boolean(String(turn.workflowTaskId || "").trim()),
  );
}
