import type { CanvasAssistantMessage } from "./canvas-agent-types";

const usageFields = ["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"] as const;
const attemptStatuses = ["running", "success", "retryable_error", "error", "cancelled"] as const;
const failureCodes = ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "AUTH", "EMPTY_RESPONSE"] as const;
const operationKinds = ["plan", "workflow", "read", "image", "create", "edit", "generate", "command", "file", "tool", "subagent"] as const;
const operationStatuses = ["running", "success", "error", "waiting", "changed"] as const;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const runID = /^(?:queue-[\da-f-]{36}|[\w-]{21})$/i;

const counter = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function canvasAgentTurnDiagnostic(replies: readonly CanvasAssistantMessage[]) {
  const attempts = replies.flatMap(reply => (reply.modelAttempts || []).map(attempt => ({
    runId: runID.test(attempt.runId) ? attempt.runId : undefined,
    requestId: uuid.test(attempt.requestId) ? attempt.requestId : undefined,
    step: counter(attempt.step),
    attempt: counter(attempt.attempt),
    purpose: attempt.purpose === "summary" || attempt.purpose === "review" ? attempt.purpose : "turn",
    status: attemptStatuses.includes(attempt.status) ? attempt.status : undefined,
    failureCode: attempt.failureCode !== undefined && failureCodes.includes(attempt.failureCode) ? attempt.failureCode : undefined,
    retryAt: typeof attempt.retryAt === "string" && !Number.isNaN(Date.parse(attempt.retryAt)) ? attempt.retryAt : undefined,
    retryDelayMs: counter(attempt.retryDelayMs),
    retryWaitMs: counter(attempt.retryWaitMs),
    rateLimited: attempt.rateLimited === true || undefined,
    elapsedMs: counter(attempt.elapsedMs),
    httpStatus: typeof attempt.httpStatus === "number" && attempt.httpStatus >= 400 && attempt.httpStatus <= 599 ? counter(attempt.httpStatus) : undefined,
    validationFailed: attempt.validationFailed === true || undefined,
    usage: Object.fromEntries(usageFields.flatMap(key => {
      const value = counter(attempt.usage?.[key]);
      return value === undefined ? [] : [[key, value]];
    })),
  })));
  const operations = replies.flatMap(reply => (reply.trace || []).flatMap(entry =>
    entry.type === "operation" && operationKinds.includes(entry.kind) && operationStatuses.includes(entry.status)
      ? [{ kind: entry.kind, status: entry.status }]
      : [],
  ));
  const totals = Object.fromEntries(usageFields.map(key => {
    let tokens = 0;
    let reported = 0;
    for (const attempt of attempts) {
      const value = attempt.usage[key];
      if (value === undefined) continue;
      tokens += value;
      reported++;
    }
    return [key, { tokens: reported ? tokens : null, reported }];
  }));
  return {
    version: 1,
    requests: attempts.length,
    outcome: replies.at(-1)?.status === "error" ? "error" : undefined,
    elapsedMs: replies.reduce((total, reply) => total + (counter(reply.elapsedMs) || 0), 0),
    attempts,
    operations,
    totals,
  };
}

export function downloadCanvasAgentTurnDiagnostic(diagnostic: ReturnType<typeof canvasAgentTurnDiagnostic>) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "canvas-agent-diagnostic.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
