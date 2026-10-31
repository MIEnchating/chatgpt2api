import { useSyncExternalStore } from "react";

const TICK_INTERVAL_MS = 1000;

const listeners = new Set<() => void>();
let snapshot = Date.now();
let timer: number | undefined;

function tick() {
  snapshot = Date.now();
  listeners.forEach((listener) => listener());
}

function startTimer() {
  if (timer === undefined) {
    timer = window.setInterval(tick, TICK_INTERVAL_MS);
  }
}

function stopTimer() {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    stopTimer();
    return;
  }
  tick();
  startTimer();
}

function subscribe(listener: () => void) {
  // Refresh on every subscribe so a freshly mounted consumer never reads a stale tick.
  snapshot = Date.now();
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (!document.hidden) {
      startTimer();
    }
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopTimer();
    }
  };
}

function getSnapshot() {
  return snapshot;
}

function subscribeNothing() {
  return () => {};
}

// One shared 1s ticker for all elapsed-time displays; paused while the tab is hidden.
export function useNow(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : subscribeNothing, getSnapshot, getSnapshot);
}
