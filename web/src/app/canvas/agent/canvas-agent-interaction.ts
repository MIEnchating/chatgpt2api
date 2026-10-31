import prompts from "../../../../../internal/service/canvas_agent_assets/prompts.json";
import type { CanvasAgentAction } from "./canvas-agent-tools";
import type { CanvasAgentPlan, CanvasAgentProtocolMessage, CanvasAgentQuestion, CanvasAgentState } from "./canvas-agent-types";

export function canvasAgentQuestion(action: CanvasAgentAction, request: string): CanvasAgentQuestion {
  const question = String(action.arguments.question);
  const reason = String(action.arguments.reason);
  const kind = action.arguments.kind as CanvasAgentQuestion["kind"];
  const purpose = action.arguments.purpose === "workflow_review" ? "workflow_review" as const : action.arguments.purpose === "media_generation" || isMediaGenerationConfirmation(kind, `${question} ${reason} ${request}`) ? "media_generation" as const : undefined;
  return { id: action.id, question, reason, options: action.arguments.options as string[], kind, ...(purpose ? { purpose } : {}), request };
}

export function canvasAgentMediaGenerationQuestion(id: string, nodeCount: number): CanvasAgentQuestion {
  const count = Math.max(1, Math.floor(nodeCount));
  return {
    id,
    purpose: "media_generation",
    kind: "confirmation",
    question: "要生成这些节点吗？",
    reason: `已准备 ${count} 个待生成节点；确认后将开始生成。`,
    options: ["立即生成", "暂不生成，继续规划"],
    request: "",
  };
}

export function canvasAgentQuestionMediaChoice(question: CanvasAgentQuestion, answer: string): "generate" | "defer" | undefined {
  const isMediaConfirmation = question.purpose === "media_generation" || isMediaGenerationConfirmation(question.kind, `${question.question} ${question.reason} ${question.request}`);
  if (!isMediaConfirmation) return undefined;
  if (/(?:暂不|不生成|先不|稍后|暂缓|不需要|取消|别生成|别提交|拒绝|不(?:要|用|必|想|需)(?:再|立即|马上)?(?:生成|提交)|不(?:可以|同意|行|能)|(?:还?没有?|尚未|未)(?:确认|同意|批准|可以))/.test(answer)) return "defer";
  if (/(?:生成|开始|启动|提交|立即|可以|同意|确认|是的|好的)/.test(answer)) return "generate";
  return undefined;
}

// Only a new, direct user request can supersede a previous media deferral.
export function canvasAgentUserMediaChoice(text: string): "generate" | undefined {
  const request = text.trim();
  if (/[?？“”「」『』"`]|(?:如果|假如|要是|能否|能不能|可不可以|是否|怎么|如何|为什么|不要|不能|不想|无需|不需要|先不|暂不|稍后|暂缓|取消|别生成|别提交|不生成|等我|确认后)|[吗么][。！!\s]*$/i.test(request)) return undefined;
  if (/^(?:(?:好的|好|可以)[，,。！!\s]*)?(?:(?:请|麻烦|你|您|帮我|给我|为我|现在|立即|直接|继续|开始|确认|同意|马上)\s*)*生成(?:吧|啊|呀|了|一下|图片|视频|音频|这|那|已有|待处理|[一二三四五六七八九十0-9]|\s|[，,。！!]|$)/.test(request)) return "generate";
  if (/^(?:please\s+)?(?:generate|create)\s+(?:the\s+)?(?:images?|videos?|audio)\b/i.test(request) && !/\b(?:not|don't|later|if|whether)\b/i.test(request)) return "generate";
  return undefined;
}

function isMediaGenerationConfirmation(kind: CanvasAgentQuestion["kind"], context: string) {
  return kind === "confirmation" && /(?:要不要|是否|现在|立即|开始|确认).{0,24}(?:生成|启动|提交)|(?:生成|启动|提交).{0,16}(?:吗|么|还是继续|还是暂缓|还是不)/.test(context);
}

export function canvasAgentPlan(action: CanvasAgentAction): CanvasAgentPlan {
  return { explanation: String(action.arguments.explanation), steps: action.arguments.steps as CanvasAgentPlan["steps"] };
}

export function resolveCanvasAgentQuestion(state: CanvasAgentState, messages: CanvasAgentProtocolMessage[], answer: string, cancelled = false) {
  const question = state.pendingQuestion;
  if (!question) throw new Error("当前没有等待回答的问题");
  const callExists = messages.some((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id === question.id && call.name === "ask_user_question"));
  const answered = messages.some((message) => message.role === "tool" && message.toolCallId === question.id);
  if (!callExists || answered) throw new Error("问题状态已变化，请重新打开当前对话");
  if (!cancelled && !answer.trim()) throw new Error("请先回答问题");
  return {
    state: { ...state, pendingQuestion: undefined },
    protocolMessages: [...messages, {
      role: "tool" as const, name: "ask_user_question", toolCallId: question.id,
      content: JSON.stringify(cancelled
        ? { ok: false, code: "user_cancelled", message: "用户取消了本次请求，不执行依赖此回答的操作。" }
        : { ok: true, answer: answer.trim() }),
    }],
  };
}

export const CANVAS_AGENT_INTERACTION_PROMPT = prompts.CANVAS_AGENT_INTERACTION_PROMPT;
