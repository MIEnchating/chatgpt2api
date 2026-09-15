import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, FilePlus2, LoaderCircle, Pencil, Plus, Settings2, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { AUTH_SESSION_CHANGE_EVENT } from "@/lib/auth-session";
import { getCachedAuthSession } from "@/lib/session";
import { useAuthSessionRevision } from "@/lib/use-auth-session-revision";
import { cn } from "@/lib/utils";
import { deleteAgentSkill, fetchAgentSkills, saveAgentSkill, type AgentSkill, type AgentSkillInput } from "@/services/api/agent-skills";

export function CanvasAgentSkillPicker(props: { selectedIds: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const revision = useAuthSessionRevision();
  return <SkillPicker key={revision} {...props} />;
}

function SkillPicker({ selectedIds, onChange, disabled }: { selectedIds: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [items, setItems] = useState<AgentSkill[]>([]);
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const sessionKey = getCachedAuthSession()?.key;
    setLoading(true);
    void fetchAgentSkills(false, controller.signal).then(({ items }) => {
      if (controller.signal.aborted || getCachedAuthSession()?.key !== sessionKey) return;
      setItems(items.filter((item) => item.enabled));
      setError("");
    }).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Skill 加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  function toggle(id: string) {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((value) => value !== id));
    else if (selectedIds.length < 5) onChange([...selectedIds, id]);
    else toast.error("最多同时选择 5 个 Skill");
  }

  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={disabled} className="gap-1.5"><BookOpen className="size-4" />Skill{selectedIds.length ? ` · ${selectedIds.length}` : ""}</Button></PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="mb-2 flex items-center justify-between"><span className="text-sm font-medium">创作 Skill</span><Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); setManage(true); }}><Settings2 className="size-3.5" />管理</Button></div>
        <p className="mb-2 text-xs text-muted-foreground">最多选 5 个，优先采用所选创作规则。</p>
        {loading ? <LoaderCircle className="mx-auto my-4 size-5 animate-spin" /> : error ? <div className="text-xs text-destructive">{error}<Button type="button" variant="ghost" size="sm" onClick={() => setRefresh((value) => value + 1)}>重试</Button></div> : null}
        <ScrollArea className="max-h-72"><div className="space-y-1">{items.map((skill) => <button key={skill.id} type="button" aria-pressed={selectedIds.includes(skill.id)} onClick={() => toggle(skill.id)} className={cn("flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted", selectedIds.includes(skill.id) && "bg-muted")}><span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border">{selectedIds.includes(skill.id) ? <Check className="size-3" /> : null}</span><span className="min-w-0"><span className="block text-sm">{skill.name}<span className="ml-2 text-[10px] text-muted-foreground">{skill.scope === "system" ? "系统" : "个人"}</span></span><span className="mt-0.5 block text-xs text-muted-foreground">{skill.description}</span></span></button>)}</div></ScrollArea>
        {selectedIds.some((id) => !items.some((item) => item.id === id)) && !loading && !error ? <p className="mt-2 text-xs text-destructive">部分所选 Skill 已被移除或停用，请重新选择。</p> : null}
        {selectedIds.length ? <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" onClick={() => onChange([])}>清空选择</Button> : null}
      </PopoverContent>
    </Popover>
    <SkillManager open={manage} onClose={() => { setManage(false); setRefresh((value) => value + 1); }} />
  </>;
}

const blankSkill = (): AgentSkillInput => ({ name: "", description: "", content: "", enabled: true, files: {} });

function SkillManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const admin = getCachedAuthSession()?.role === "admin";
  const [system, setSystem] = useState(false);
  const [items, setItems] = useState<AgentSkill[]>([]);
  const [editing, setEditing] = useState<AgentSkill | null>(null);
  const [draft, setDraft] = useState<AgentSkillInput>(blankSkill);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [deleteID, setDeleteID] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const mutationRef = useRef<AbortController | null>(null);
  const readEpochRef = useRef(0);
  const [reading, setReading] = useState(false);

  function invalidateRead() {
    readEpochRef.current += 1;
    setReading(false);
  }

  useEffect(() => {
    const cancel = () => { mutationRef.current?.abort(); readEpochRef.current += 1; };
    window.addEventListener(AUTH_SESSION_CHANGE_EVENT, cancel);
    return () => { cancel(); window.removeEventListener(AUTH_SESSION_CHANGE_EVENT, cancel); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchAgentSkills(system, controller.signal).then(({ items }) => {
      if (!controller.signal.aborted) setItems(items.filter((item) => item.scope === (system ? "system" : "personal")));
    }).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Skill 加载失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, system, refresh]);

  async function mutate(operation: (signal: AbortSignal) => Promise<unknown>) {
    if (mutationRef.current || reading) return;
    invalidateRead();
    const controller = new AbortController();
    mutationRef.current = controller;
    const sessionKey = getCachedAuthSession()?.key;
    setBusy(true);
    try {
      await operation(controller.signal);
      if (controller.signal.aborted || getCachedAuthSession()?.key !== sessionKey) return;
      setEditorOpen(false); setDeleteID(""); setRefresh((value) => value + 1);
      toast.success("Skill 已保存");
    } catch (error) {
      if (!controller.signal.aborted && getCachedAuthSession()?.key === sessionKey) toast.error(error instanceof Error ? error.message : "Skill 操作失败");
    } finally {
      if (mutationRef.current === controller) { mutationRef.current = null; setBusy(false); }
    }
  }

  async function importMarkdown(file: File | undefined) {
    if (!file) return;
    if (!/\.md$/i.test(file.name) || file.size > 128 * 1024) return toast.error("请选择 128 KiB 以内的 Markdown 文件");
    const sessionKey = getCachedAuthSession()?.key;
    const epoch = ++readEpochRef.current;
    setReading(true);
    try {
      const content = await file.text();
      if (readEpochRef.current !== epoch || getCachedAuthSession()?.key !== sessionKey) return;
      setEditing(null); setDraft({ ...blankSkill(), name: file.name.replace(/\.md$/i, ""), content }); setEditorOpen(true);
    } catch { if (readEpochRef.current === epoch) toast.error("文件读取失败"); }
    finally { if (readEpochRef.current === epoch) setReading(false); }
  }

  async function addAttachments(files: FileList | null) {
    if (!files || !system || !editorOpen) return;
    const sessionKey = getCachedAuthSession()?.key;
    const epoch = ++readEpochRef.current;
    setReading(true);
    try {
      const entries = await Promise.all(Array.from(files).map(async (file) => {
        if (!/\.(md|txt)$/i.test(file.name) || file.size > 128 * 1024) throw new Error("附属文件必须是 128 KiB 以内的 Markdown 或文本");
        return [`references/${file.name}`, await file.text()] as const;
      }));
      if (readEpochRef.current !== epoch || getCachedAuthSession()?.key !== sessionKey) return;
      const nextFiles = { ...draft.files, ...Object.fromEntries(entries) };
      if (Object.keys(nextFiles).length > 30 || new TextEncoder().encode(draft.content + Object.values(nextFiles).join("")).length > 512 * 1024) throw new Error("附属文件最多 30 个，Skill 总大小最多 512 KiB");
      setDraft((current) => ({ ...current, files: nextFiles }));
    } catch (error) { if (readEpochRef.current === epoch) toast.error(error instanceof Error ? error.message : "附属文件读取失败"); }
    finally { if (readEpochRef.current === epoch) setReading(false); }
  }

  return <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) { invalidateRead(); setEditorOpen(false); setDeleteID(""); onClose(); } }}>
    <DialogContent className="max-w-3xl">
      <DialogHeader><DialogTitle>Skill 管理</DialogTitle><DialogDescription>维护可复用的创作规则。个人 Skill 随账号保存，系统 Skill 由管理员维护。</DialogDescription></DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant={system ? "outline" : "secondary"} disabled={busy} onClick={() => { invalidateRead(); setSystem(false); setEditorOpen(false); setDeleteID(""); }}>个人</Button>
        {admin ? <Button type="button" variant={system ? "secondary" : "outline"} disabled={busy} onClick={() => { invalidateRead(); setSystem(true); setEditorOpen(false); setDeleteID(""); }}>系统</Button> : null}
        <Button type="button" variant="outline" disabled={busy} onClick={() => { invalidateRead(); setEditing(null); setDraft(blankSkill()); setEditorOpen(true); }}><Plus />新建</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => importRef.current?.click()}><Upload />导入 Markdown</Button>
        <input ref={importRef} type="file" accept=".md,text/markdown" hidden onChange={(event) => { void importMarkdown(event.target.files?.[0]); event.target.value = ""; }} />
      </div>
      {reading ? <p role="status" className="text-xs text-muted-foreground">正在读取文件…</p> : null}
      {editorOpen ? <fieldset disabled={busy || reading} className="space-y-3">
        <label className="block space-y-1 text-sm"><span>名称</span><Input value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>说明</span><Input value={draft.description} maxLength={500} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>创作规则</span><Textarea aria-label="创作规则" value={draft.content} rows={10} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="描述适用场景、创作步骤、输出格式和约束。" /></label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.enabled} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked === true })} />启用</label>
        {system ? <div className="space-y-2"><Button type="button" variant="outline" size="sm" onClick={() => attachmentRef.current?.click()}><FilePlus2 />添加附属文件</Button><input ref={attachmentRef} type="file" accept=".md,.txt" multiple hidden onChange={(event) => { void addAttachments(event.target.files); event.target.value = ""; }} /><p className="text-xs text-muted-foreground">在创作规则中引用下面的相对路径，Agent 会按需读取。</p>{Object.keys(draft.files || {}).map((path) => <div key={path} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{path}</span><Button type="button" size="icon" variant="ghost" aria-label={`移除 ${path}`} onClick={() => setDraft((current) => ({ ...current, files: Object.fromEntries(Object.entries(current.files || {}).filter(([key]) => key !== path)) }))}><X /></Button></div>)}</div> : null}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" className="h-10 w-24" onClick={() => { invalidateRead(); setEditorOpen(false); }}>取消</Button><Button type="button" className="h-10 w-24" onClick={() => void mutate((signal) => saveAgentSkill({ ...draft, revision: editing?.revision }, editing?.id, system, signal))}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}保存</Button></div>
      </fieldset> : <div className="space-y-2">
        {loading ? <LoaderCircle className="mx-auto my-8 animate-spin" /> : error ? <p className="text-sm text-destructive">{error}<Button type="button" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>重试</Button></p> : !items.length ? <p className="py-8 text-center text-sm text-muted-foreground">暂无 Skill，可以新建或导入 Markdown。</p> : items.map((skill) => <div key={skill.id} className="rounded-lg border border-border p-3"><div className="flex items-center gap-2"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{skill.name}{!skill.enabled ? "（已停用）" : ""}</p><p className="text-xs text-muted-foreground">{skill.description}</p></div><Button type="button" size="icon" variant="ghost" disabled={busy} aria-label={`编辑 ${skill.name}`} onClick={() => { invalidateRead(); setEditing(skill); setDraft({ name: skill.name, description: skill.description, content: skill.content, enabled: skill.enabled, files: skill.files || {} }); setEditorOpen(true); }}><Pencil /></Button><Button type="button" size="icon" variant="ghost" disabled={busy} aria-label={`删除 ${skill.name}`} onClick={() => setDeleteID(skill.id)}><Trash2 /></Button></div>{deleteID === skill.id ? <div className="mt-2 flex items-center justify-end gap-2 text-xs"><span>确认删除该 Skill？</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDeleteID("")}>取消</Button><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void mutate((signal) => deleteAgentSkill(skill, signal))}>删除</Button></div> : null}</div>)}
      </div>}
    </DialogContent>
  </Dialog>;
}
