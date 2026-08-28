"use client";

import { useRef } from "react";
import { toast } from "sonner";

import {
  CreativeWorkflowWorkspace,
  type WorkflowExternalTaskFailure,
  type WorkflowExternalTaskStart,
  type WorkflowExternalTaskSuccess,
} from "@/components/workflows/creative-workflow-workspace";
import {
  createWorkflowImageConversation,
  workflowTaskIsTerminal,
  workflowImageConversationFailure,
  workflowImageConversationSuccess,
} from "@/app/workflows/workflow-image-history";
import { getImageConversation, saveImageConversation, type ImageConversation } from "@/store/image-conversations";

export default function WorkflowsPage() {
  const pendingHistoryRef = useRef(new Map<string, Promise<ImageConversation | null>>());

  const reportPersistenceError = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : "工作流结果写入图片历史失败");
  };

  const handleTaskStarted = (task: WorkflowExternalTaskStart) => {
    const conversation = { ...createWorkflowImageConversation(task), revision: 1 };
    const pending = getImageConversation(conversation.id)
      .then((existing) => existing || saveImageConversation(conversation))
      .catch((error) => {
        reportPersistenceError(error);
        return null;
      });
    pendingHistoryRef.current.set(task.taskId, pending);
  };

  const handleTaskSuccess = (task: WorkflowExternalTaskSuccess) => {
    const pending = pendingHistoryRef.current.get(task.taskId);
    if (!pending) return;
    void pending
      .then((conversation) => conversation
        ? workflowTaskIsTerminal(conversation, task.taskId)
          ? conversation
          : saveImageConversation({
              ...workflowImageConversationSuccess(conversation, task),
              revision: (conversation.revision || 1) + 1,
            })
        : null)
      .catch(reportPersistenceError)
      .finally(() => pendingHistoryRef.current.delete(task.taskId));
  };

  const handleTaskFailure = (task: WorkflowExternalTaskFailure) => {
    const pending = pendingHistoryRef.current.get(task.taskId);
    if (!pending) return;
    void pending
      .then((conversation) => conversation
        ? workflowTaskIsTerminal(conversation, task.taskId)
          ? conversation
          : saveImageConversation({
              ...workflowImageConversationFailure(conversation, task),
              revision: (conversation.revision || 1) + 1,
            })
        : null)
      .catch(reportPersistenceError)
      .finally(() => pendingHistoryRef.current.delete(task.taskId));
  };

  return (
    <CreativeWorkflowWorkspace
      onWorkflowTaskStarted={handleTaskStarted}
      onWorkflowTaskSuccess={handleTaskSuccess}
      onWorkflowTaskFailure={handleTaskFailure}
    />
  );
}
