import { useEffect, useRef, useState } from "react";

export function useCanvasAgentRecommendationCountdown({ scope, enabled, onAccept }: {
  scope: unknown;
  enabled: boolean;
  onAccept: () => void;
}) {
  const [seconds, setSeconds] = useState<number | null>(10);
  const stoppedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const acceptRef = useRef(onAccept);
  useEffect(() => { acceptRef.current = onAccept; }, [onAccept]);
  useEffect(() => {
    stoppedRef.current = false;
    setSeconds(10);
  }, [scope]);
  useEffect(() => {
    if (!enabled || stoppedRef.current) return;
    const deadline = Date.now() + 10_000;
    setSeconds(10);
    const timer = window.setInterval(() => {
      if (stoppedRef.current) return;
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
      setSeconds(remaining);
      if (remaining === 0) {
        stoppedRef.current = true;
        window.clearInterval(timer);
        timerRef.current = null;
        setSeconds(null);
        acceptRef.current();
      }
    }, 250);
    timerRef.current = timer;
    return () => { window.clearInterval(timer); timerRef.current = null; };
  }, [scope, enabled]);
  function stop() {
    stoppedRef.current = true;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setSeconds(null);
  }
  return { seconds: enabled ? seconds : null, stop };
}
