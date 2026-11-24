import type { CanvasAssistantSession } from "./canvas-agent-types";

const operationStatus = { running: "进行中", success: "已完成", error: "失败", waiting: "等待确认", changed: "状态已变化" };

function inlineText(text: string) {
  return text.replace(/\s+/g, " ").trim().replace(/[\\`*_{}[\]<>~]/g, "\\$&");
}

function closeCodeFence(text: string) {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    const [, marker, suffix] = fence;
    if (!open) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && !suffix.trim()) open = undefined;
  }
  return open ? `${text}\n${open}` : text;
}

export function canvasAgentSessionMarkdown(session: CanvasAssistantSession) {
  const sections = [`# ${inlineText(session.title) || "画布对话"}`];
  for (const message of session.messages) {
    const body: string[] = [];
    const text = message.text.trimEnd();
    const operations = (message.trace || []).flatMap(entry =>
      entry.type === "operation" ? [`- ${inlineText(entry.label)} · ${operationStatus[entry.status]}`] : []);
    if (operations.length) {
      body.push(["<details>", "<summary>操作记录</summary>", "", ...operations, "", "</details>"].join("\n"));
    }
    if (text.trim()) body.push(closeCodeFence(text));
    for (const reference of message.references || []) {
      body.push(`- 素材：${inlineText(reference.title || reference.label || "未命名")}`);
    }
    if (body.length) sections.push([`## ${message.role === "user" ? "用户" : "助手"}`, ...body].join("\n\n"));
  }
  return sections.join("\n\n") + "\n";
}
