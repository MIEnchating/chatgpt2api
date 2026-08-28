import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { nanoid } from "nanoid";
import { ArrowUp, Bot, FolderOpen, History, Image as ImageIcon, LoaderCircle, Menu, MessageSquarePlus, PanelRightClose, RotateCcw, Sparkles, Square, Trash2, Upload, Video, X } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { buildAllCanvasResourceReferences, type CanvasResourceReference } from "@/app/canvas/canvas-resources";
import { CanvasAgentPromptChipInput } from "@/app/canvas/canvas-agent-prompt-chip-input";
import {
  CanvasAgentImageSettings,
  CanvasAgentVideoSettings,
} from "@/app/canvas/canvas-agent-generation-settings";
import {
  canvasAgentImageSettingsSummary,
  canvasAgentVideoSettingsSummary,
} from "@/app/canvas/canvas-agent-generation-settings-summary";
import { runCanvasAgent, createCanvasAgentState } from "@/app/canvas/agent/canvas-agent-runtime";
import type { CanvasAgentContext } from "@/app/canvas/agent/canvas-agent-context";
import type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";
import type { CanvasAgentConfig, CanvasAssistantMessage, CanvasAssistantReference, CanvasAssistantSession } from "@/app/canvas/agent/canvas-agent-types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchAuthenticatedImageBlob } from "@/lib/authenticated-image";
import { getStoredRelayTokenName } from "@/lib/relay-token-selection";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "@/services/api/canvas";
import type { StoredAuthSession } from "@/store/auth";

export type { CanvasAgentAction, CanvasAgentToolResult } from "@/app/canvas/agent/canvas-agent-tools";

function createSession(): CanvasAssistantSession {
  const now = new Date().toISOString();
  return { id: nanoid(), title: "新对话", messages: [], agentState: createCanvasAgentState(), protocolMessages: [], createdAt: now, updatedAt: now };
}

type PendingDeleteConfirmation = { title: string; resolve: (confirmed: boolean) => void };

export function CanvasAgentPanel({ open, session, nodes, selectedNodeIDs, referenceNodeClick, model, imageModel, videoModel, configuredSystemPrompt, initialSessions, initialActiveSessionID, initialRequest, agentConfig, width, getAgentContext, onSessionsChange, onAgentConfigChange, onWidthChange, onExecuteAction, onOpenUpload, onOpenAssets, onPasteImage, onInitialRequestConsumed, onClose }: {
  open: boolean;
  session: StoredAuthSession;
  nodes: CanvasNode[];
  selectedNodeIDs: string[];
  referenceNodeClick: { nodeID: string | null; version: number };
  model: string;
  imageModel: string;
  videoModel: string;
  configuredSystemPrompt?: string;
  initialSessions: CanvasAssistantSession[];
  initialActiveSessionID?: string;
  initialRequest?: { prompt: string; references: CanvasAssistantReference[] } | null;
  agentConfig: CanvasAgentConfig;
  width: number;
  getAgentContext: (state: CanvasAssistantSession["agentState"]) => CanvasAgentContext;
  onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionID: string) => void;
  onAgentConfigChange: (patch: Partial<CanvasAgentConfig>) => void;
  onWidthChange: (width: number) => void;
  onExecuteAction: (action: CanvasAgentAction, messageReferenceNodeIDs: string[]) => Promise<CanvasAgentToolResult>;
  onOpenUpload: () => void;
  onOpenAssets: () => void;
  onPasteImage: (file: File) => void;
  onInitialRequestConsumed?: () => void;
  onClose: () => void;
}) {
  const [initialSession] = useState(createSession);
  const sessions = useMemo(() => initialSessions.length ? initialSessions : [initialSession], [initialSession, initialSessions]);
  const activeSessionID = initialActiveSessionID && sessions.some((item) => item.id === initialActiveSessionID) ? initialActiveSessionID : sessions[0].id;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [checkedSessionIDs, setCheckedSessionIDs] = useState<string[]>([]);
  const [deleteSessionIDs, setDeleteSessionIDs] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteConfirmation | null>(null);
  const [composerReferenceNodeIDs, setComposerReferenceNodeIDs] = useState<string[]>([]);
  const [removedReferenceNodeIDs, setRemovedReferenceNodeIDs] = useState<Set<string>>(new Set());
  const [resizing, setResizing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingDeleteRef = useRef<PendingDeleteConfirmation | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const consumedReferenceNodeClickVersionRef = useRef(0);
  const consumedInitialRequestRef = useRef<typeof initialRequest>(null);
  const submitInitialRequestRef = useRef<(prompt: string, references: CanvasAssistantReference[]) => void>(() => undefined);
  const sessionsRef = useRef(sessions);
  const activeSessionIDRef = useRef(activeSessionID);
  const nodesRef = useRef(nodes);
  const selectedNodeIDsRef = useRef(selectedNodeIDs);
  nodesRef.current = nodes;
  selectedNodeIDsRef.current = selectedNodeIDs;
  const activeSession = sessions.find((item) => item.id === activeSessionID) || sessions[0];
  const historySessions = sessions.filter((item) => item.messages.length > 0);
  const selectedNodeKey = useMemo(() => [...selectedNodeIDs].sort().join(","), [selectedNodeIDs]);
  const resourceReferences = useMemo(() => buildAllCanvasResourceReferences(nodes), [nodes]);
  const resourceReferenceByID = useMemo(() => new Map(resourceReferences.map((reference) => [reference.nodeID, reference])), [resourceReferences]);
  const pendingReferences = useMemo(() => {
    const clickedNodeID = referenceNodeClick.version > consumedReferenceNodeClickVersionRef.current ? referenceNodeClick.nodeID : null;
    return resourceReferences.filter((reference) => selectedNodeIDs.includes(reference.nodeID)
      && ((!composerReferenceNodeIDs.includes(reference.nodeID) && !removedReferenceNodeIDs.has(reference.nodeID)) || reference.nodeID === clickedNodeID));
  }, [composerReferenceNodeIDs, referenceNodeClick, removedReferenceNodeIDs, resourceReferences, selectedNodeIDs]);

  useEffect(() => {
    sessionsRef.current = sessions;
    activeSessionIDRef.current = activeSessionID;
  }, [activeSessionID, sessions]);

  useEffect(() => {
    setRemovedReferenceNodeIDs(new Set());
  }, [selectedNodeKey]);

  useEffect(() => {
    setComposerReferenceNodeIDs((current) => current.filter((nodeID) => resourceReferenceByID.has(nodeID)));
  }, [resourceReferenceByID]);

  useEffect(() => () => {
    abortRef.current?.abort();
    pendingDeleteRef.current?.resolve(false);
    pendingDeleteRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    if (view !== "chat") return;
    const frame = window.requestAnimationFrame(() => {
      const element = messageListRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSession.messages, view]);

  function settleDeleteConfirmation(confirmed: boolean) {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    pending.resolve(confirmed);
  }

  function commit(next: CanvasAssistantSession[], nextActiveID = activeSessionIDRef.current) {
    sessionsRef.current = next;
    activeSessionIDRef.current = nextActiveID;
    onSessionsChange(next, nextActiveID);
  }

  function updateSession(sessionID: string, updater: (value: CanvasAssistantSession) => CanvasAssistantSession) {
    commit(sessionsRef.current.map((item) => item.id === sessionID ? updater(item) : item));
  }

  function newSession() {
    setInput("");
    setComposerReferenceNodeIDs([]);
    setRemovedReferenceNodeIDs(new Set());
    if (activeSession && !activeSession.messages.length) {
      setView("chat");
      return commit(sessionsRef.current, activeSession.id);
    }
    const next = createSession();
    commit([next, ...sessionsRef.current], next.id);
    setView("chat");
  }

  function removeSessions(sessionIDs: string[]) {
    const next = sessionsRef.current.filter((item) => !sessionIDs.includes(item.id));
    if (!next.length) {
      const replacement = createSession();
      commit([replacement], replacement.id);
    } else {
      commit(next, sessionIDs.includes(activeSessionIDRef.current) ? next[0].id : activeSessionIDRef.current);
    }
    setCheckedSessionIDs((current) => current.filter((sessionID) => !sessionIDs.includes(sessionID)));
  }

  async function submit(nextText = input, savedReferences?: CanvasAssistantReference[], referenceNodeIDs = composerReferenceNodeIDs) {
    const text = nextText.trim();
    if (!text || busy || !activeSession) return;
    const relayTokenName = getStoredRelayTokenName(session, "text");
    if (!relayTokenName) return toast.error("请先在个人中心选择文本生成密钥");
    if (!model) return toast.error("请先配置文本模型");
    const references = savedReferences
      ? await hydrateSavedReferences(nodesRef.current, savedReferences, resourceReferenceByID)
      : await referencesForNodeIDs(nodesRef.current, referenceNodeIDs, resourceReferenceByID);
    const messageReferenceNodeIDs = references.map((reference) => reference.id);
    const userID = nanoid();
    const assistantID = nanoid();
    const now = new Date().toISOString();
    const userMessage = { id: userID, role: "user" as const, text, references, status: "success" as const };
    updateSession(activeSession.id, (current) => ({ ...current, title: current.messages.length ? current.title : text.slice(0, 18) || "新对话", messages: [...current.messages, userMessage, { id: assistantID, role: "assistant", text: "", status: "thinking", activity: "正在理解画布和创作目标" }], updatedAt: now }));
    setInput("");
    setComposerReferenceNodeIDs([]);
    setRemovedReferenceNodeIDs(new Set(selectedNodeIDsRef.current));
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await runCanvasAgent({
        model,
        relayTokenName,
        configuredSystemPrompt,
        initialState: activeSession.agentState,
        protocolMessages: activeSession.protocolMessages,
        userText: text,
        references,
        getContext: getAgentContext,
        executeAction: async (action) => {
          if (action.name !== "delete_node") return onExecuteAction(action, messageReferenceNodeIDs);
          const nodeID = typeof action.arguments.nodeId === "string" ? action.arguments.nodeId : "";
          const node = nodesRef.current.find((item) => item.id === nodeID);
          const confirmed = await new Promise<boolean>((resolve) => {
            const pending = { title: node?.title || "未命名节点", resolve };
            pendingDeleteRef.current = pending;
            setPendingDelete(pending);
          });
          return confirmed ? onExecuteAction(action, messageReferenceNodeIDs) : { ok: false, code: "delete_cancelled", message: "用户取消删除，原节点已保留" };
        },
        signal: controller.signal,
        onEvent: (event) => updateSession(activeSession.id, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? { ...message, status: event.status, activity: event.label } : message), updatedAt: new Date().toISOString() })),
        onCheckpoint: (checkpoint) => updateSession(activeSession.id, (current) => ({ ...current, agentState: checkpoint.state, protocolMessages: checkpoint.protocolMessages, updatedAt: new Date().toISOString() })),
      });
      updateSession(activeSession.id, (current) => ({ ...current, agentState: result.state, protocolMessages: result.protocolMessages, messages: current.messages.map((message) => message.id === assistantID ? { ...message, text: result.reply, status: "success", activity: undefined } : message), updatedAt: new Date().toISOString() }));
    } catch (error) {
      const stopped = error instanceof Error && error.name === "AbortError";
      updateSession(activeSession.id, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantID ? { ...message, text: stopped ? "已停止继续执行。已经创建的节点和已经提交的媒体任务会保留。" : error instanceof Error ? error.message : "Agent 执行失败", status: stopped ? "waiting" : "error", activity: undefined } : message), updatedAt: new Date().toISOString() }));
      if (!stopped) toast.error(error instanceof Error ? error.message : "Agent 执行失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  function retryMessage(message: CanvasAssistantMessage) {
    const index = activeSession.messages.findIndex((item) => item.id === message.id);
    const userMessage = activeSession.messages.slice(0, index).findLast((item) => item.role === "user");
    if (userMessage) void submit(userMessage.text, userMessage.references);
  }

  function startResize() {
    const move = (event: MouseEvent) => onWidthChange(Math.min(760, Math.max(320, window.innerWidth - event.clientX - 12)));
    const stop = () => {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  }

  submitInitialRequestRef.current = (prompt, references) => {
    void submit(prompt, references);
  };

  useEffect(() => {
    if (!initialRequest || consumedInitialRequestRef.current === initialRequest) return;
    consumedInitialRequestRef.current = initialRequest;
    onInitialRequestConsumed?.();
    submitInitialRequestRef.current(initialRequest.prompt, initialRequest.references);
  }, [initialRequest, onInitialRequestConsumed]);

  return <aside
    aria-hidden={!open}
    inert={!open}
    data-canvas-agent-panel
    data-state={open ? "open" : "closed"}
    className="absolute inset-y-3 right-3 z-40 flex max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl sm:inset-y-4 sm:right-4 sm:max-w-[calc(100%-2rem)]"
    style={{
      width: `min(${width}px, calc(100% - 12px))`,
      transform: open ? "translateX(0)" : "translateX(calc(100% + 16px))",
      opacity: open ? 1 : 0,
      pointerEvents: open ? "auto" : "none",
      transition: resizing ? "none" : "width 150ms ease, transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease",
    }}
  >
    <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整右侧面板宽度" />
    <header className="flex min-h-12 items-center gap-2 border-b px-3"><Bot className="size-4 text-[#1456f0]" /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{view === "history" ? "历史对话" : "Agent"}</span>{view === "history" ? <><Button size="icon" variant="ghost" title="删除所选" aria-label="删除所选对话" disabled={!checkedSessionIDs.length} onClick={() => setDeleteSessionIDs(checkedSessionIDs)}><Trash2 /></Button><Button size="icon" variant="ghost" title="删除全部" aria-label="删除全部对话" disabled={!historySessions.length} onClick={() => setDeleteSessionIDs(historySessions.map((item) => item.id))}><X /></Button></> : null}<Button size="icon" variant={view === "history" ? "secondary" : "ghost"} title={view === "history" ? "返回对话" : "历史记录"} aria-label={view === "history" ? "返回对话" : "历史记录"} onClick={() => setView((current) => current === "history" ? "chat" : "history")}><History /></Button><Button size="icon" variant="ghost" title="新对话" aria-label="新对话" disabled={busy} onClick={newSession}><MessageSquarePlus /></Button><Button size="icon" variant="ghost" title="收起对话" aria-label="收起 Agent" onClick={onClose}><PanelRightClose /></Button></header>
    <ScrollArea className="min-h-0 flex-1" viewportRef={messageListRef} viewportClassName="p-3"><div className="space-y-3">{view === "history" ? <AssistantHistory sessions={historySessions} activeSession={activeSession} checkedIDs={checkedSessionIDs} onToggleChecked={(id, checked) => setCheckedSessionIDs((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))} onOpen={(id) => { commit(sessionsRef.current, id); setView("chat"); }} onDelete={(id) => setDeleteSessionIDs([id])} /> : activeSession.messages.length ? <AssistantMessages messages={activeSession.messages} onRetry={retryMessage} /> : <div className="flex min-h-72 flex-col items-center justify-center px-8 text-center"><div className="grid size-12 place-items-center rounded-lg bg-muted"><Sparkles className="size-5" /></div><div className="mt-4 text-base font-medium">从一个想法开始</div><div className="mt-2 max-w-[260px] text-sm leading-6 text-muted-foreground">描述故事、宣传片或现有素材，Agent 会与你沟通并直接操作当前画布</div></div>}</div></ScrollArea>
    {view === "chat" ? <div className="border-t p-2">
      {pendingDelete ? <div className="mb-2 overflow-hidden rounded-lg border"><div className="px-3 py-2"><p className="truncate text-xs font-medium">删除“{pendingDelete.title}”？</p><p className="mt-1 text-[11px] text-muted-foreground">相关连线和任务记录将按现有逻辑清理</p></div><div className="grid grid-cols-2 border-t"><button type="button" className="h-8 text-xs hover:bg-muted" onClick={() => settleDeleteConfirmation(false)}>取消</button><button type="button" className="h-8 border-l text-xs font-medium text-rose-600 hover:bg-muted" onClick={() => settleDeleteConfirmation(true)}>确认删除</button></div></div> : null}
      <div className="rounded-xl border border-border px-3 pb-3 pt-3">
        <CanvasAgentPromptChipInput
          value={input}
          references={resourceReferences}
          pendingReferences={pendingReferences}
          onChange={setInput}
          onReferenceIDsChange={(ids) => {
            consumedReferenceNodeClickVersionRef.current = referenceNodeClick.version;
            const removedSelectedIDs = composerReferenceNodeIDs.filter((id) => selectedNodeIDsRef.current.includes(id) && !ids.includes(id));
            if (removedSelectedIDs.length) setRemovedReferenceNodeIDs((current) => new Set([...current, ...removedSelectedIDs]));
            setComposerReferenceNodeIDs(ids);
          }}
          onPasteImage={onPasteImage}
          onSubmit={(prompt, referenceIDs) => void submit(prompt, undefined, referenceIDs)}
          className="min-h-20 max-h-[220px] w-full px-1 py-0 text-sm leading-5"
          placeholder="描述创作目标，或让我继续操作画布"
          placeholderClassName="!left-1 !top-0"
        />
        <div className="mt-2 flex min-w-0 items-center gap-1">
          <AgentAssetMenu onOpenUpload={onOpenUpload} onOpenAssets={onOpenAssets} />
          <AgentParameterMenu icon={<ImageIcon />} label="图片参数" summary={canvasAgentImageSettingsSummary(agentConfig.imageQuality, agentConfig.imageSize)}><CanvasAgentImageSettings model={imageModel} quality={agentConfig.imageQuality} size={agentConfig.imageSize} onChange={onAgentConfigChange} /></AgentParameterMenu>
          <AgentParameterMenu icon={<Video />} label="视频参数" summary={canvasAgentVideoSettingsSummary(agentConfig.videoQuality, agentConfig.videoSize)}><CanvasAgentVideoSettings model={videoModel} quality={agentConfig.videoQuality} size={agentConfig.videoSize} onChange={onAgentConfigChange} /></AgentParameterMenu>
          <Button type="button" size="icon" className="size-9 shrink-0 rounded-full" disabled={!busy && !input.trim()} aria-label={busy ? "停止" : "发送"} onClick={() => busy ? (settleDeleteConfirmation(false), abortRef.current?.abort()) : void submit()}>{busy ? <Square className="fill-current" /> : <ArrowUp />}</Button>
        </div>
      </div>
    </div> : null}
    <Dialog open={deleteSessionIDs.length > 0} onOpenChange={(open) => !open && setDeleteSessionIDs([])}><DialogContent className="w-[min(92vw,420px)]"><DialogHeader><DialogTitle>删除对话记录？</DialogTitle><DialogDescription>将删除 {deleteSessionIDs.length} 条对话记录，此操作不可撤销。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setDeleteSessionIDs([])}>取消</Button><Button type="button" variant="destructive" onClick={() => { removeSessions(deleteSessionIDs); setDeleteSessionIDs([]); }}>删除</Button></DialogFooter></DialogContent></Dialog>
  </aside>;
}

function AgentAssetMenu({ onOpenUpload, onOpenAssets }: { onOpenUpload: () => void; onOpenAssets: () => void }) {
  return <Popover><PopoverTrigger asChild><Button type="button" size="icon" variant="secondary" className="size-9 shrink-0 rounded-full" aria-label="添加 Agent 素材"><Menu /></Button></PopoverTrigger><PopoverContent side="top" align="start" className="w-40 p-1.5"><button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted" onClick={onOpenUpload}><Upload className="size-4" />上传文件</button><button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted" onClick={onOpenAssets}><FolderOpen className="size-4" />我的素材</button></PopoverContent></Popover>;
}

function AgentParameterMenu({ icon, label, summary, children }: { icon: React.ReactNode; label: string; summary: string; children: React.ReactNode }) {
  return <Popover><PopoverTrigger asChild><Button type="button" variant="secondary" className="h-9 min-w-0 flex-1 !gap-0.5 rounded-full !px-1.5 text-[10px] [&_svg]:size-3" aria-label={label}>{icon}<span className="truncate">{summary}</span></Button></PopoverTrigger><PopoverContent side="top" align="center" className="w-[min(calc(100vw-2rem),23rem)] overflow-hidden p-0" onOpenAutoFocus={(event) => event.preventDefault()}><ScrollArea className="max-h-[min(70dvh,32rem)]"><div className="space-y-3 p-3 pr-4"><p className="text-xs font-semibold">{label}</p>{children}</div></ScrollArea></PopoverContent></Popover>;
}

const ASSISTANT_MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4" />,
};

function AssistantMarkdown({ children }: { children: string }) {
  return <div className={cn("min-w-0 whitespace-normal break-words", "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0", "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h1:first-child]:mt-0", "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0", "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:font-semibold [&_h3:first-child]:mt-0", "[&_h4]:my-2 [&_h4]:font-semibold", "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1", "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[color:var(--agent-markdown-border)] [&_blockquote]:pl-3 [&_blockquote]:opacity-80", "[&_hr]:my-3 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-[color:var(--agent-markdown-border)]", "[&_code]:rounded [&_code]:bg-[var(--agent-markdown-surface)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]", "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--agent-markdown-surface)] [&_pre]:p-3", "[&_pre_code]:bg-transparent [&_pre_code]:p-0", "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border-b [&_th]:border-[color:var(--agent-markdown-border)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_td]:border-b [&_td]:border-[color:var(--agent-markdown-border)] [&_td]:px-2 [&_td]:py-1.5")} style={{ "--agent-markdown-surface": "var(--muted)", "--agent-markdown-border": "var(--border)" } as CSSProperties}><ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MARKDOWN_COMPONENTS} skipHtml>{children}</ReactMarkdown></div>;
}

function AssistantMessages({ messages, onRetry }: { messages: CanvasAssistantMessage[]; onRetry: (message: CanvasAssistantMessage) => void }) {
  return <>{messages.map((message) => {
    const running = message.status === "thinking" || message.status === "running";
    return <div key={message.id} className={cn("flex flex-col gap-2", message.role === "user" ? "items-end" : "items-start")}>
      {message.text ? <div className={cn("max-w-[88%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-6", message.role === "user" ? "bg-[#e7efff] dark:bg-blue-950/50" : "bg-muted")}>
        {message.role === "assistant" ? <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Bot className="size-3.5" />Agent</div> : null}
        {message.role === "assistant" ? <AssistantMarkdown>{message.text}</AssistantMarkdown> : <UserMessageContent message={message} />}
      </div> : null}
      {running ? <div className="flex w-[250px] items-center gap-2 rounded-xl border px-3 py-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{message.activity || "正在执行"}</div> : null}
      {message.role === "assistant" && !running && message.text ? <Button size="icon" variant="outline" className="size-7 rounded-full" title="重试" aria-label="重试" onClick={() => onRetry(message)}><RotateCcw className="size-3.5" /></Button> : null}
    </div>;
  })}</>;
}

function AssistantHistory({ sessions, activeSession, checkedIDs, onToggleChecked, onOpen, onDelete }: { sessions: CanvasAssistantSession[]; activeSession: CanvasAssistantSession; checkedIDs: string[]; onToggleChecked: (id: string, checked: boolean) => void; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  if (!sessions.length) return <div className="py-10 text-center text-xs text-muted-foreground">暂无历史对话</div>;
  return <div className="space-y-1">{sessions.map((item) => <div key={item.id} className={cn("group flex items-center gap-2 rounded-lg px-2 py-1.5", item.id === activeSession.id && "bg-muted")}><input type="checkbox" className="size-4" aria-label={`选择对话 ${item.title}`} checked={checkedIDs.includes(item.id)} onChange={(event) => onToggleChecked(item.id, event.target.checked)} /><button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => onOpen(item.id)}><span className="block truncate">{item.title}</span><span className="text-xs text-muted-foreground">{item.messages.length} 条消息</span></button><Button size="icon" variant="ghost" className="size-7 opacity-0 transition group-hover:opacity-100" title="删除" aria-label={`删除对话 ${item.title}`} onClick={() => onDelete(item.id)}><Trash2 className="size-3.5" /></Button></div>)}</div>;
}

function UserMessageContent({ message }: { message: CanvasAssistantMessage }) {
  const references = useMemo(() => message.references?.map(assistantToPromptReference) || [], [message.references]);
  return <CanvasAgentPromptChipInput value={message.text} references={references} onChange={() => undefined} readOnly />;
}

function assistantToPromptReference(reference: CanvasAssistantReference): CanvasResourceReference {
  const kind = reference.type === "video" ? "video" : reference.type === "audio" ? "audio" : reference.type === "text" ? "text" : "image";
  return { id: reference.id, nodeID: reference.id, kind, label: reference.label || reference.title, title: reference.title, previewURL: reference.dataUrl || reference.url, text: reference.text, active: true };
}

async function referencesForNodeIDs(nodes: CanvasNode[], nodeIDs: readonly string[], referenceByID: ReadonlyMap<string, CanvasResourceReference>): Promise<CanvasAssistantReference[]> {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return Promise.all(nodeIDs.flatMap((nodeID) => {
    const node = nodeByID.get(nodeID);
    const reference = referenceByID.get(nodeID);
    return node && reference ? [canvasAgentReferenceFromNode(node, reference.label)] : [];
  }));
}

async function hydrateSavedReferences(nodes: CanvasNode[], references: readonly CanvasAssistantReference[], referenceByID: ReadonlyMap<string, CanvasResourceReference>) {
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  return Promise.all(references.map(async (reference) => {
    const node = nodeByID.get(reference.id);
    return node && referenceByID.has(reference.id) ? canvasAgentReferenceFromNode(node, referenceByID.get(reference.id)?.label || reference.label) : reference;
  }));
}

async function canvasAgentReferenceFromNode(node: CanvasNode, label?: string): Promise<CanvasAssistantReference> {
  let dataUrl: string | undefined;
  if ((node.type === "image" || node.type === "panorama") && node.url) {
    try {
      const blob = await fetchAuthenticatedImageBlob(node.url);
      dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("读取引用失败")); reader.onload = () => resolve(String(reader.result || "")); reader.readAsDataURL(blob); });
    } catch {
      dataUrl = node.url;
    }
  }
  return { id: node.id, type: node.type, title: node.title || node.type, label: label || node.title || node.id, dataUrl, url: node.url, mimeType: node.mime_type, text: node.type === "text" ? node.prompt : undefined };
}
