import type { CanvasAssistantMessage } from "./canvas-agent-types";

export type CanvasAgentTaskGroup = {
  id: string;
  request?: CanvasAssistantMessage;
  replies: CanvasAssistantMessage[];
  steering?: CanvasAssistantMessage[];
};

// Clarification answers and resumed replies belong to the original request.
export function canvasAgentTaskGroups(messages: readonly CanvasAssistantMessage[]) {
  const groups: CanvasAgentTaskGroup[] = [];
  for (const message of messages) {
    if (message.role === "user" && message.steeringAssistantId && groups.length) {
      (groups.at(-1)!.steering ||= []).push(message);
    } else if (message.role === "user" && !message.questionAnswerFor) {
      groups.push({ id: message.id, request: message, replies: [] });
    } else if (message.role === "assistant") {
      if (!groups.length) groups.push({ id: message.id, replies: [] });
      groups.at(-1)!.replies.push(message);
    }
  }
  return groups;
}
