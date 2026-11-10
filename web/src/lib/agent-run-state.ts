export type AgentRunStatus = "running" | "waiting" | "interrupted" | "cancelled" | "error" | "success";

export const AGENT_RUN_STATE: Record<AgentRunStatus, { label: string; description: string; resumable: boolean }> = {
  running: { label: "正在执行", description: "任务在后台执行，关闭面板后仍会继续", resumable: false },
  waiting: { label: "等待处理", description: "进度已保存，处理待办后可继续", resumable: true },
  interrupted: { label: "执行中断", description: "进度已保存，可从中断处继续", resumable: true },
  cancelled: { label: "已停止", description: "进度已保存，可继续未完成的任务", resumable: true },
  error: { label: "执行失败", description: "请检查错误后继续任务", resumable: true },
  success: { label: "执行完成", description: "结果已保存", resumable: false },
};
