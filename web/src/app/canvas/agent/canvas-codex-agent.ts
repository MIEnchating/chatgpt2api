import { useEffect, useRef, useState } from "react";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { connectCanvasCodex, type CanvasCodexEvent, type CanvasCodexLink, type CanvasCodexModel, type CanvasCodexRPC } from "@/services/api/canvas-codex";
import { readAgentSkillFile } from "@/services/api/agent-skills";
import { buildCanvasAgentSkillPrompt } from "./canvas-agent-skills";
import { CANVAS_AGENT_SKILL_FILE_TOOL, CANVAS_AGENT_TOOLS, normalizeCanvasAgentAction, type CanvasAgentAction, type CanvasAgentToolResult } from "./canvas-agent-tools";
import { applyAgentState, applyTaskResult, type RunCanvasAgentInput } from "./canvas-agent-runtime";
import type { CanvasAgentState } from "./canvas-agent-types";

type RunResult = { reply: string; state: CanvasAgentState; protocolMessages: RunCanvasAgentInput["protocolMessages"]; contextCheckpoint?: string; codexThreadId: string; codexServiceId: string };
export type CanvasCodexApproval = { title: string; details: string; questions?: Array<{ id: string; question: string; options?: Array<{ label: string; description?: string }> }> };
export type CanvasCodexAnswer = { accepted: boolean; answers?: Record<string, string> };
type ActiveRun = { input: RunCanvasAgentInput; state: CanvasAgentState; text: string; threadId: string; turnId: string; done: (result: RunResult) => void; fail: (error: Error) => void; calls: number; pendingMessages: CanvasCodexRPC[]; fileChanges: Map<string, unknown[]>; cleanup: () => void };
const READ_TOOLS = new Set(["get_canvas_summary", "get_selected_nodes", "query_canvas_nodes", "get_node", "get_upstream_nodes", "get_downstream_nodes", "get_connected_nodes", "get_generation_config", "get_generation_task", "get_media_task_status"]);

export function useCanvasCodexAgent(input: { canvasId: string; onDisconnect: () => void; executeAction: (action: CanvasAgentAction) => Promise<CanvasAgentToolResult>; ask: (approval: CanvasCodexApproval, signal: AbortSignal) => Promise<CanvasCodexAnswer> }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<CanvasCodexModel[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [sessionId, setSessionId] = useState("");
  const linkRef = useRef<CanvasCodexLink | null>(null);
  const connectionRef = useRef<AbortController | null>(null);
  const activeRef = useRef<ActiveRun | null>(null);
  const inputRef = useRef(input);
  const toolQueue = useRef(Promise.resolve());
  const pendingExternal = useRef(new Map<string, AbortController>());
  const pendingRequests = useRef(new Map<number | string, AbortController>());
  inputRef.current = input;
  function disconnect() {
    inputRef.current.onDisconnect();
    connectionRef.current?.abort();
    connectionRef.current = null;
    linkRef.current?.disconnect();
    linkRef.current = null;
    activeRef.current?.cleanup();
    activeRef.current?.fail(new Error("Codex 连接已断开"));
    activeRef.current = null;
    for (const controller of pendingExternal.current.values()) controller.abort();
    pendingExternal.current.clear();
    for (const controller of pendingRequests.current.values()) controller.abort();
    pendingRequests.current.clear();
    toolQueue.current = Promise.resolve();
    setConnected(false);
    setConnecting(false);
    setSessionId("");
  }
  useEffect(() => {
    const onSessionChange = () => disconnect();
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, onSessionChange);
    return () => { window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, onSessionChange); disconnect(); };
    // The connection belongs to the mounted canvas and is never transferred.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.canvasId]);
  async function execute(name: string, args: unknown, callId: string, source: "codex" | "mcp", signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
    const action = normalizeCanvasAgentAction(name, args, callId);
    const run = activeRef.current;
    if (source === "codex" && (!run || run.input.signal?.aborted || ++run.calls > 144)) return { ok: false, code: "run_finished", message: "本轮操作已结束或达到上限" };
    if (action.name === "read_skill_file") {
      const skill = run?.input.activeSkills?.find((item) => item.id === action.arguments.skillId);
      const path = String(action.arguments.path);
      if (!skill || !(skill.file_paths || Object.keys(skill.files || {})).includes(path)) return { ok: false, code: "skill_file_not_selected", message: "文件不属于本轮所选 Skill" };
      return { ok: true, ...await readAgentSkillFile(skill.id, path, signal) };
    }
    if (source === "mcp" && !READ_TOOLS.has(name)) {
      const answer = await inputRef.current.ask({ title: "外部 MCP 请求操作画布", details: `${name}\n${JSON.stringify(action.arguments, null, 2)}` }, signal);
      if (!answer.accepted) return { ok: false, code: "user_declined", message: "用户未允许此操作" };
    }
    if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
    if (source === "codex" && name === "arrange_nodes" && (!/整理|排列|排序|对齐|布局|排版|重新摆放/.test(run!.input.userText) || /(不要|别|无需|不用).{0,8}(整理|排列|排序|对齐|布局|排版|重新摆放)/.test(run!.input.userText))) return { ok: false, code: "action_not_requested", message: "用户没有要求整理画布" };
    const result = await waitForAction(source === "codex" ? run!.input.executeAction(action) : inputRef.current.executeAction(action), signal);
    if (run && activeRef.current === run && source === "codex") {
      run.state = action.name === "set_agent_state" && result.ok ? applyAgentState(run.state, action.arguments) : applyTaskResult(run.state, result);
      run.input.onCheckpoint?.({ state: run.state, protocolMessages: run.input.protocolMessages, contextCheckpoint: run.input.contextCheckpoint });
    }
    return result;
  }
  function onEvent(event: CanvasCodexEvent, controller: AbortController) {
    if (controller.signal.aborted || connectionRef.current !== controller) return;
    if (event.type === "disconnected") { setError(event.message); disconnect(); return; }
    if (event.type === "tool-cancel") { pendingExternal.current.get(event.requestId)?.abort(); return; }
    if (event.type === "tool") {
      const external = new AbortController();
      pendingExternal.current.set(event.requestId, external);
      toolQueue.current = toolQueue.current.then(async () => {
        const link = linkRef.current;
        if (!link || controller.signal.aborted) return;
        let result;
        try { result = await execute(event.name, event.arguments, event.requestId, "mcp", AbortSignal.any([controller.signal, external.signal])); }
        catch (reason) { result = { ok: false, message: reason instanceof Error ? reason.message : "工具执行失败" }; }
        pendingExternal.current.delete(event.requestId);
        if (!controller.signal.aborted && !external.signal.aborted) await link.toolResult(event.requestId, result).catch(() => undefined);
      }).catch(() => undefined);
      return;
    }
    const message = event.message;
    const params = message.params;
    const run = activeRef.current;
    if (message.method === "serverRequest/resolved") {
      pendingRequests.current.get(params.requestId as number | string)?.abort();
      if (run) run.pendingMessages = run.pendingMessages.filter((item) => item.id !== params.requestId);
      return;
    }
    const eventTurnId = String(params.turnId || (params.turn as { id?: string } | undefined)?.id || "");
    if (run && params.threadId === run.threadId && eventTurnId && !run.turnId) {
      if (run.pendingMessages.length >= 128) { setError("Codex 启动期间事件过多"); disconnect(); return; }
      run.pendingMessages.push(message);
      return;
    }
    if (message.id !== undefined) {
      const request = new AbortController();
      pendingRequests.current.set(message.id, request);
      toolQueue.current = toolQueue.current.then(() => handleServerRequest(message, AbortSignal.any([controller.signal, request.signal]), run)).catch(() => undefined).finally(() => pendingRequests.current.delete(message.id!));
      return;
    }
    if (!run || params.threadId !== run.threadId || !run.turnId || eventTurnId !== run.turnId) return;
    if (message.method === "item/started") {
      const item = params.item as { type?: string; id?: string; changes?: unknown[] } | undefined;
      if (item?.type === "fileChange" && item.id && Array.isArray(item.changes)) run.fileChanges.set(item.id, item.changes);
    }
    if (message.method === "item/agentMessage/delta") { run.text += String(params.delta || ""); run.input.onEvent?.({ status: "thinking", label: "Codex 正在回复" }); }
    if (message.method === "item/completed") {
      const item = params.item as { type?: string; text?: string } | undefined;
      if (item?.type === "agentMessage" && item.text) run.text = item.text;
    }
    if (message.method === "turn/completed") {
      const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
      activeRef.current = null;
      run.cleanup();
      if (turn?.status === "failed") run.fail(new Error(turn.error?.message || "Codex 执行失败"));
      else if (turn?.status === "interrupted") run.fail(new DOMException("Codex 已停止", "AbortError"));
      else run.done({ reply: run.text || "Codex 本轮执行完成。", state: run.state, protocolMessages: run.input.protocolMessages, contextCheckpoint: run.input.contextCheckpoint, codexThreadId: run.threadId, codexServiceId: linkRef.current!.serviceId });
    }
  }
  async function handleServerRequest(message: CanvasCodexRPC, signal: AbortSignal, expectedRun: ActiveRun | null) {
    const link = linkRef.current;
    if (!link || signal.aborted || message.id === undefined) return;
    const run = activeRef.current;
    const params = message.params;
    if (!run || run !== expectedRun || params.threadId !== run.threadId || !run.turnId || params.turnId !== run.turnId) { await link.reject(message.id, "任务已结束或不属于当前对话").catch(() => undefined); return; }
    const runSignal = run.input.signal ? AbortSignal.any([signal, run.input.signal]) : signal;
    try {
      if (message.method === "item/tool/call") {
        const result = await execute(String(params.tool), params.arguments, String(params.callId), "codex", runSignal);
        if (!signal.aborted) await link.reply(message.id, { contentItems: [{ type: "inputText", text: JSON.stringify(result) }], success: result.ok });
      } else {
        if (!["item/tool/requestUserInput", "item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) throw new Error("不支持的 Codex 请求");
        const questions = message.method === "item/tool/requestUserInput" ? params.questions as CanvasCodexApproval["questions"] : undefined;
        const changes = message.method === "item/fileChange/requestApproval" ? run.fileChanges.get(String(params.itemId)) : undefined;
        if (message.method === "item/fileChange/requestApproval" && (!changes?.length || changes.some((change) => !change || typeof (change as { path?: unknown }).path !== "string" || typeof (change as { diff?: unknown }).diff !== "string"))) {
          run.input.onEvent?.({ status: "thinking", label: "未收到文件修改差异，已拒绝本次修改" });
          await link.reply(message.id, { decision: "decline" });
          return;
        }
        const response = await inputRef.current.ask({ title: questions ? "Codex 需要补充信息" : "Codex 请求本地操作授权", details: JSON.stringify(changes ? { ...params, changes } : params, null, 2), questions }, runSignal);
        const result = questions ? { answers: Object.fromEntries((questions || []).map((question) => [question.id, { answers: response.accepted && response.answers?.[question.id] ? [response.answers[question.id]] : [] }])) } : { decision: response.accepted ? "accept" : "decline" };
        if (!signal.aborted) await link.reply(message.id, result);
      }
    } catch (reason) { if (!signal.aborted) await link.reject(message.id, reason instanceof Error ? reason.message : "工具执行失败").catch(() => undefined); }
  }
  async function connect(endpoint: string, token: string) {
    disconnect();
    const controller = new AbortController();
    connectionRef.current = controller;
    const accountKey = getCachedAuthSession()?.key;
    setConnecting(true); setError("");
    try {
      const tools = [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL].map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
      if (!accountKey) throw new Error("登录状态已失效");
      const scopeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([window.location.origin, accountKey, input.canvasId])));
      const canvasScope = Array.from(new Uint8Array(scopeBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const link = await connectCanvasCodex({ endpoint, token, canvasId: canvasScope, tools, signal: controller.signal, onEvent: (event) => onEvent(event, controller) });
      if (controller.signal.aborted || connectionRef.current !== controller || getCachedAuthSession()?.key !== accountKey) { link.disconnect(); return; }
      linkRef.current = link;
      const account = await link.rpc<{ account: unknown }>("account/read");
      if (!account.account) throw new Error("请先在本地终端运行 codex login");
      const available: CanvasCodexModel[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: CanvasCodexModel[]; nextCursor: string | null } = await link.rpc("model/list", { cursor });
        available.push(...page.data);
        cursor = page.nextCursor;
        if (available.length > 1000) throw new Error("Codex 模型列表过长");
      } while (cursor);
      if (controller.signal.aborted) return;
      setModels(available); setModel(available[0]?.model || ""); setEffort(available[0]?.defaultReasoningEffort || "");
      setSessionId(link.sessionId); setConnected(true);
    } catch (reason) { if (!controller.signal.aborted) { disconnect(); setError(reason instanceof Error ? reason.message : "Codex 连接失败"); } }
    finally { if (connectionRef.current === controller) setConnecting(false); }
  }
  async function run(runInput: RunCanvasAgentInput & { codexThreadId?: string; codexServiceId?: string; onThread?: (threadId: string, serviceId: string) => void }): Promise<RunResult> {
    const link = linkRef.current;
    if (!link || !connected || !model) throw new Error("请先连接本地 Codex 并选择模型");
    if (activeRef.current) throw new Error("Codex 已有进行中的任务");
    if (runInput.signal?.aborted) throw new DOMException("任务已取消", "AbortError");
    const developerInstructions = [runInput.configuredSystemPrompt, "你正在操作登录用户的创作画布。只通过提供的画布工具修改项目；媒体是否提交由画布自动生成开关决定。", buildCanvasAgentSkillPrompt(runInput.initialState.phase, runInput.userText, runInput.getContext(runInput.initialState), runInput.activeSkills, runInput.contextCheckpoint)].filter(Boolean).join("\n\n");
    const reuse = runInput.codexServiceId === link.serviceId && runInput.codexThreadId;
    const { thread } = await link.rpc<{ thread: { id: string } }>(reuse ? "thread/resume" : "thread/start", { ...(reuse ? { threadId: reuse } : {}), model, developerInstructions });
    if (runInput.signal?.aborted || linkRef.current !== link) throw new DOMException("任务已取消", "AbortError");
    runInput.onThread?.(thread.id, link.serviceId);
    return new Promise<RunResult>((resolve, reject) => {
      const onAbort = () => {
        const current = activeRef.current;
        if (!current) return;
        activeRef.current = null;
        current.cleanup();
        if (current.turnId) void link.rpc("turn/interrupt", { threadId: current.threadId, turnId: current.turnId }).catch(() => undefined);
        reject(new DOMException("Codex 已停止", "AbortError"));
      };
      const active: ActiveRun = { input: runInput, state: runInput.initialState, text: "", threadId: thread.id, turnId: "", calls: 0, pendingMessages: [], fileChanges: new Map(), done: resolve, fail: reject, cleanup: () => runInput.signal?.removeEventListener("abort", onAbort) };
      activeRef.current = active;
      runInput.signal?.addEventListener("abort", onAbort, { once: true });
      const references = runInput.references.map((reference) => `${reference.label || reference.title} = 节点 ${reference.id}`).join("；");
      const turnInput: Array<{ type: string; text?: string; url?: string }> = [{ type: "text", text: `${runInput.userText}${references ? `\n引用：${references}` : ""}` }];
      for (const reference of runInput.references) if (reference.dataUrl && /^(data:image\/|https?:\/\/)/.test(reference.dataUrl)) turnInput.push({ type: "image", url: reference.dataUrl });
      void link.rpc<{ turn: { id: string } }>("turn/start", { threadId: thread.id, input: turnInput, model, ...(effort ? { effort } : {}) }).then(({ turn }) => {
        if (activeRef.current === active) {
          active.turnId = turn.id;
          const queued = active.pendingMessages; active.pendingMessages = [];
          const connection = connectionRef.current;
          if (connection) for (const message of queued) onEvent({ type: "rpc", message }, connection);
        } else void link.rpc("turn/interrupt", { threadId: thread.id, turnId: turn.id }).catch(() => undefined);
      }).catch((reason) => { if (activeRef.current === active) { activeRef.current = null; active.cleanup(); reject(reason); } });
    });
  }
  return { connected, connecting, error, models, model, effort, sessionId, connect, disconnect, run, setModel: (name: string) => { setModel(name); setEffort(models.find((item) => item.model === name)?.defaultReasoningEffort || ""); }, setEffort };
}

function waitForAction<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new DOMException("操作已取消", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then((result) => { signal.removeEventListener("abort", abort); resolve(result); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
