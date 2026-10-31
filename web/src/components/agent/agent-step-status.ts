import { Check, CircleAlert, Clock, LoaderCircle, Square, type LucideIcon } from "lucide-react";

// Shared step states for every agent surface (canvas, video contract import, workflow draft).
export type AgentStepStatus = "running" | "success" | "error" | "waiting" | "changed" | "partial" | "interrupted";

export type AgentStepTone = "brand" | "destructive" | "muted";

export const AGENT_STEP_STATUS: Record<AgentStepStatus, { label: string; icon: LucideIcon; tone: AgentStepTone; spin?: boolean }> = {
  running: { label: "执行中", icon: LoaderCircle, tone: "brand", spin: true },
  success: { label: "已完成", icon: Check, tone: "muted" },
  error: { label: "失败", icon: CircleAlert, tone: "destructive" },
  waiting: { label: "待继续", icon: Clock, tone: "muted" },
  changed: { label: "已调整", icon: Check, tone: "muted" },
  partial: { label: "部分完成", icon: CircleAlert, tone: "muted" },
  interrupted: { label: "已中断", icon: Square, tone: "muted" },
};

export const AGENT_STEP_TONE_CLASS: Record<AgentStepTone, string> = {
  brand: "text-brand",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};
