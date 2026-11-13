import { useEffect, useRef, useState } from "react";
import type { CanvasAgentContext } from "./agent/canvas-agent-context";
import type { CanvasAgentProtocolMessage } from "./agent/canvas-agent-types";

type TokenEstimateInput = {
  messages: CanvasAgentProtocolMessage[];
  summary?: string;
  context: CanvasAgentContext;
};

type TokenEstimate = { tokens?: number; error?: string };
type EstimateWorker = {
  worker?: Worker;
  requestID: number;
  ready: boolean;
  input?: TokenEstimateInput;
  error?: string;
  fail: (error: string) => void;
};

// Retain each transcript in its worker while the canvas context changes.
export function useCanvasAgentTokenEstimate(input: TokenEstimateInput | undefined): TokenEstimate {
  const [result, setResult] = useState<TokenEstimate & { input: TokenEstimateInput; owner: EstimateWorker }>();
  const current = useRef<EstimateWorker | undefined>(undefined);
  const messages = input?.messages;
  const summary = input?.summary;

  useEffect(() => {
    if (!messages) return;
    const state: EstimateWorker = {
      requestID: 0,
      ready: false,
      fail(error) {
        if (current.current !== state) return;
        state.error = error;
        if (state.input) setResult({ input: state.input, owner: state, error });
        release();
      },
    };
    const release = () => {
      const worker = state.worker;
      if (!worker) return;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      state.worker = undefined;
    };
    current.current = state;
    try {
      const worker = new Worker(new URL("./agent/canvas-agent-token-estimate.worker.ts", import.meta.url), { type: "module" });
      state.worker = worker;
      worker.onmessage = (event: MessageEvent<{ type?: unknown; requestID?: unknown; tokens?: unknown; error?: unknown }>) => {
        if (current.current !== state || !state.worker || !state.input) return;
        const response = event.data;
        if (response?.type === "ready") {
          if (state.ready) return;
          state.ready = true;
          try {
            worker.postMessage({ type: "history", messages, summary });
            worker.postMessage({ type: "estimate", requestID: state.requestID, context: state.input.context });
          } catch {
            state.fail("上下文用量估算失败");
          }
          return;
        }
        if (!state.ready) return;
        if (response?.requestID !== state.requestID) return;
        if (typeof response.tokens !== "number" || !Number.isSafeInteger(response.tokens) || response.tokens < 0) {
          state.fail("上下文用量估算失败");
          return;
        }
        setResult({ input: state.input, owner: state, tokens: response.tokens });
      };
      worker.onerror = (event) => {
        event.preventDefault();
        state.fail("上下文用量估算失败");
      };
      worker.onmessageerror = () => state.fail("上下文用量估算结果无法读取");
    } catch {
      state.fail("上下文用量估算失败");
    }
    return () => {
      if (current.current === state) current.current = undefined;
      release();
    };
  }, [messages, summary]);

  useEffect(() => {
    const state = current.current;
    if (!input || !state) return;
    state.input = input;
    if (state.error) {
      setResult({ input, owner: state, error: state.error });
      return;
    }
    state.requestID += 1;
    if (!state.ready) return;
    try {
      state.worker!.postMessage({ type: "estimate", requestID: state.requestID, context: input.context });
    } catch {
      state.fail("上下文用量估算失败");
    }
  }, [input]);

  return result && result.owner === current.current && result.input === input ? { tokens: result.tokens, error: result.error } : {};
}
