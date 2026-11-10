import { cancelCreationTask, createChatGenerationTask, fetchCreationTasks, type CreationTask } from "@/lib/api";
import type { ImageConversation, ImageTurn } from "@/lib/image-conversation-types";
import { waitForCreationTask } from "@/lib/creation-task-events";
import { resolveImageRequestURL } from "@/lib/authenticated-image";
import { buildStudioPromptContext, parseStudioPromptPlan } from "@/lib/studio-prompt-context";
import { imageToDataURL } from "@/services/image-storage";

export async function prepareStudioPromptContext(input: {
  conversation: ImageConversation;
  turn: ImageTurn;
  referenceLimit: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  isSessionCurrent: () => boolean;
}) {
  const { conversation, turn, referenceLimit, signal, assertCurrent, isSessionCurrent } = input;
  const context = turn.promptContext;
  if (!context) throw new Error("缺少智能上下文配置");
  const { messages, images } = buildStudioPromptContext(conversation, turn, referenceLimit);
  const check = () => { signal.throwIfAborted(); assertCurrent(); };
  check();
  let task: CreationTask | undefined;
  try {
    const existing = await fetchCreationTasks([context.taskId], { signal });
    check();
    task = existing.items.find(item => item.id === context.taskId);
    if (!task) {
      const content = messages[1].content;
      if (!Array.isArray(content)) throw new Error("上下文消息格式无效");
      for (const { id, label, image } of images) {
        const url = await imageToDataURL({ url: resolveImageRequestURL(image.dataUrl) }, signal);
        check();
        content.push({ type: "text", text: `${id}: ${label}` }, { type: "image_url", image_url: { url } });
      }
      check();
      task = await createChatGenerationTask({
        clientTaskId: context.taskId, prompt: turn.prompt, model: context.model,
        messages, stream: true, maxOutputTokens: 4096, relayTokenName: context.tokenName,
        requestOptions: { signal },
      });
      check();
    }
    if (task.status === "queued" || task.status === "running") {
      task = await waitForCreationTask(task.id, { signal, timeoutMs: 180_000, onProgress: check });
    }
    check();
    if (task.status !== "success") throw new Error(task.error || "文本模型整理上下文失败，请重试或切换为直接生成");
    return parseStudioPromptPlan(task.data?.map(item => item.text_response || "").join("\n") || "", images, referenceLimit);
  } catch (error) {
    // A cancelled submit may have reached the server before its response arrived.
    if ((signal.aborted || !task || task.status === "queued" || task.status === "running") && isSessionCurrent()) {
      await cancelCreationTask(context.taskId).catch(() => undefined);
    }
    throw error;
  }
}
