import conversation from "../../../../../internal/service/canvas_agent_assets/conversation.json";

export const CANVAS_AGENT_CONVERSATION_PROMPT = conversation.prompt;

// Match only complete social messages; mixed requests retain the full agent flow.
export function isCanvasAgentConversation(text: string) {
  return conversation.messages.includes(text.trim().toLowerCase().replace(/^[\s。！？!?.,，]+|[\s。！？!?.,，]+$/g, ""));
}
