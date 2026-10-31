import { useCallback, useRef } from "react";

// Returns a referentially stable function that always calls the latest callback.
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
