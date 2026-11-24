import { useId, useState } from "react";
import { nanoid } from "nanoid";
import { Plus, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TooltipHint } from "@/components/ui/tooltip";
import type { CanvasAgentGoal } from "./agent/canvas-agent-types";

const statusLabel = { active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已验收" };

export function CanvasAgentGoalControl({ goal, busy, canAutoContinue, onSave, onContinue }: {
  goal?: CanvasAgentGoal;
  busy: boolean;
  canAutoContinue: boolean;
  onSave: (value: CanvasAgentGoal | undefined) => Promise<void>;
  onContinue: (goal: CanvasAgentGoal, rounds?: number) => boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState<CanvasAgentGoal>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [rounds, setRounds] = useState(0);
  const canContinue = goal?.status === "active" && JSON.stringify(goal) === JSON.stringify(draft);
  const done = draft?.criteria.filter(item => item.done).length ?? 0;
  const canSave = draft && draft.objective.trim() && draft.criteria.length > 0 && draft.criteria.every(item => item.text.trim())
    && (draft.status !== "complete" || done === draft.criteria.length)
    && (draft.status !== "blocked" || draft.blocker?.trim());
  const progress = goal ? `${statusLabel[goal.status]} · ${goal.criteria.filter(item => item.done).length}/${goal.criteria.length}` : "";

  function edit() {
    setError("");
    setRounds(0);
    setDraft(goal ? structuredClone(goal) : { objective: "", status: "active", criteria: [{ id: nanoid(), text: "", done: false }] });
  }

  async function save(value?: CanvasAgentGoal) {
    if (busy || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(value ? {
        objective: value.objective.trim(),
        status: value.status,
        criteria: value.criteria.map(item => ({ ...item, text: item.text.trim() })),
        ...(value.status === "blocked" ? { blocker: value.blocker?.trim() } : {}),
      } : undefined);
      setDraft(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : "目标保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <TooltipHint content={goal ? `创作目标 · ${progress}` : "创作目标"}>
      <Button type="button" size="icon" variant={goal ? "secondary" : "ghost"} aria-label="创作目标" aria-haspopup="dialog" onClick={edit}><Target /></Button>
    </TooltipHint>
    {draft ? <Dialog open onOpenChange={open => { if (!open && !saving) setDraft(undefined); }}>
      <DialogContent className="flex flex-col">
        <DialogHeader>
          <DialogTitle>创作目标</DialogTitle>
          <DialogDescription>{progress || "为当前对话记录跨轮目标和验收条件。"}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0" contentClassName="grid gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-objective`}>目标</FieldLabel>
            <Textarea id={`${id}-objective`} value={draft.objective} maxLength={500} disabled={busy || saving} onChange={event => setDraft({ ...draft, objective: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-status`}>状态</FieldLabel>
            <Select value={draft.status} disabled={busy || saving} onValueChange={(status: CanvasAgentGoal["status"]) => setDraft({ ...draft, status })}>
              <SelectTrigger id={`${id}-status`}><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(statusLabel).map(([value, label]) => <SelectItem key={value} value={value} disabled={value === "complete" && (!done || done !== draft.criteria.length)}>{label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {draft.status === "blocked" ? <Field>
            <FieldLabel htmlFor={`${id}-blocker`}>阻塞原因</FieldLabel>
            <Textarea id={`${id}-blocker`} value={draft.blocker || ""} maxLength={500} disabled={busy || saving} onChange={event => setDraft({ ...draft, blocker: event.target.value })} />
          </Field> : null}
          <Field>
            <FieldLabel>验收清单 · {done}/{draft.criteria.length}</FieldLabel>
            {draft.criteria.map((item, index) => <div key={item.id} className="flex items-center gap-2">
              <Checkbox aria-label={`验收第 ${index + 1} 项`} checked={item.done} disabled={busy || saving} onCheckedChange={checked => setDraft({
                ...draft,
                status: draft.status === "complete" && checked !== true ? "active" : draft.status,
                criteria: draft.criteria.map(criterion => criterion.id === item.id ? { ...criterion, done: checked === true } : criterion),
              })} />
              <Input aria-label={`验收条件 ${index + 1}`} value={item.text} maxLength={200} disabled={busy || saving} onChange={event => setDraft({
                ...draft,
                status: draft.status === "complete" ? "active" : draft.status,
                criteria: draft.criteria.map(criterion => criterion.id === item.id ? { ...criterion, text: event.target.value, done: false } : criterion),
              })} />
              <Button type="button" size="icon" variant="ghost" aria-label={`移除第 ${index + 1} 项`} disabled={busy || saving || draft.criteria.length === 1} onClick={() => setDraft({ ...draft, criteria: draft.criteria.filter(criterion => criterion.id !== item.id) })}><X /></Button>
            </div>)}
            <Button type="button" size="sm" variant="outline" disabled={busy || saving || draft.criteria.length >= 12} onClick={() => setDraft({
              ...draft,
              status: draft.status === "complete" ? "active" : draft.status,
              criteria: [...draft.criteria, { id: nanoid(), text: "", done: false }],
            })}><Plus />添加验收条件</Button>
          </Field>
          {canContinue && canAutoContinue ? <Field>
            <FieldLabel htmlFor={`${id}-rounds`}>本次自动续跑</FieldLabel>
            <Select value={String(rounds)} disabled={busy || saving} onValueChange={value => setRounds(Number(value))}>
              <SelectTrigger id={`${id}-rounds`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">关闭</SelectItem>
                {[1, 2, 3].map(count => <SelectItem key={count} value={String(count)}>最多续跑 {count} 轮</SelectItem>)}
              </SelectContent>
            </Select>
          </Field> : null}
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </ScrollArea>
        <DialogFooter>
          {goal ? <Button type="button" variant="ghost" disabled={busy || saving} onClick={() => { void save(); }}>清除目标</Button> : null}
          {canContinue ? <Button type="button" variant="outline" disabled={busy || saving} onClick={() => {
            if (onContinue(goal, canAutoContinue ? rounds : 0)) setDraft(undefined);
          }}>{canAutoContinue && rounds > 0 ? "开始自动续跑" : "继续目标"}</Button> : null}
          <Button type="button" disabled={busy || saving || !canSave} onClick={() => void save(draft)}>{saving ? "正在保存" : "保存目标"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog> : null}
  </>;
}
