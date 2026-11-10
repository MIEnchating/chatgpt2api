import { Spinner } from "@/components/ui/spinner";
import { ArrowUp, ListTodo, X } from "lucide-react";
import { TooltipHint } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Trace,
  TraceIcon,
  TraceLine,
  TraceTitle,
  TraceDescription,
} from "@/components/ui/trace";
import type { CanvasAgentMessageQueue } from "./agent/canvas-agent-types";
export function CanvasAgentQueuedMessages({
  queue,
  disabled,
  onRemove,
  onSteer,
}: {
  queue?: CanvasAgentMessageQueue;
  disabled: boolean;
  onRemove: (id: string) => void;
  onSteer: (id: string) => void;
}) {
  if (!queue?.messages.length) return null;
  return (
    <div
      data-agent-message-queue
      className="min-h-0 shrink-0 space-y-2 pb-2"
      data-ai-element="queue"
    >
      <TraceLine>
        <TraceIcon>
          <ListTodo />
        </TraceIcon>
        <TraceTitle>待发送消息</TraceTitle>
        <TraceDescription>
          {queue.messages.length} 条{queue.paused ? " · 已暂停" : ""}
        </TraceDescription>
      </TraceLine>
      <Trace>
        {queue.messages.map((message) => (
          <div key={message.id} className="flex min-w-0 items-center gap-1">
            <span
              className="min-w-0 flex-1 truncate text-sm"
              title={message.text}
            >
              {message.text}
            </span>
            <TooltipHint content="暂停当前执行，并发送这条消息">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`立即引导：${message.text}`}
                disabled={disabled}
                onClick={() => onSteer(message.id)}
              >
                {queue.steeringId === message.id ? (
                  <Spinner aria-hidden="true" />
                ) : (
                  <ArrowUp />
                )}
              </Button>
            </TooltipHint>
            <TooltipHint content="移除排队消息">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`移除排队消息：${message.text}`}
                disabled={disabled}
                onClick={() => onRemove(message.id)}
              >
                <X />
              </Button>
            </TooltipHint>
          </div>
        ))}
      </Trace>
    </div>
  );
}
