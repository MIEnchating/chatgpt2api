import { useLayoutEffect, useState, type RefObject } from "react";

// The editor owns token positions; React owns the controls inside each token.
export function useContentEditableReferenceTargets(editorRef: RefObject<HTMLElement | null>, selector: string) {
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const sync = () => {
      const next = Array.from(editor.querySelectorAll<HTMLElement>(selector));
      setTargets(current => current.length === next.length && current.every((target, index) => target === next[index]) ? current : next);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(editor, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [editorRef, selector]);
  return targets;
}
