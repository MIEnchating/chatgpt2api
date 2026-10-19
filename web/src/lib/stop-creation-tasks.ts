import { toast } from "sonner";

import { cancelCreationTask, type CreationTaskRequestOptions } from "@/lib/api";
import { getCachedAuthSession } from "@/lib/session";

export async function stopCreationTasks(ids: string[], options?: CreationTaskRequestOptions, expectedSessionKey = getCachedAuthSession()?.key) {
  const current = () => getCachedAuthSession()?.key === expectedSessionKey;
  if (!current()) throw new DOMException("Session changed", "AbortError");
  const taskIDs = [...new Set(ids)];
  const results = await Promise.allSettled(taskIDs.map((id) => cancelCreationTask(id, options)));
  if (!current()) throw new DOMException("Session changed", "AbortError");
  const failed = results.flatMap((result, index) => result.status === "rejected" ? [taskIDs[index]] : []);
  if (failed.length) {
    toast.error(`本地已停止，${failed.length} 个服务端任务停止失败`, {
      duration: Infinity,
      action: {
        label: "重试停止",
        onClick: () => { void stopCreationTasks(failed, options, expectedSessionKey).catch(() => undefined); },
      },
    });
  } else {
    toast.success("已停止生成任务");
  }
  return results;
}
