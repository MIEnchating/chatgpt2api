import { Check, CircleAlert, Clock, LoaderCircle, Square, type LucideIcon } from "lucide-react";

// Shared step states for every agent surface (canvas, video contract import, workflow draft).
export type AgentStepStatus = "running" | "success" | "error" | "waiting" | "changed" | "partial" | "interrupted";

export const AGENT_STEP_STATUS: Record<AgentStepStatus, { label: string; icon: LucideIcon; spin?: boolean }> = {
  running: { label: "执行中", icon: LoaderCircle, spin: true },
  success: { label: "已完成", icon: Check },
  error: { label: "失败", icon: CircleAlert },
  waiting: { label: "待继续", icon: Clock },
  changed: { label: "已调整", icon: Check },
  partial: { label: "部分完成", icon: CircleAlert },
  interrupted: { label: "已中断", icon: Square },
};
