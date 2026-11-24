import { toast } from "sonner";

export async function copyClipboardText(text: string | (() => Promise<string>)): Promise<void> {
  if (!window.isSecureContext) {
    throw new Error("当前 HTTP 页面无法访问剪贴板，请使用 HTTPS 或手动选择文字复制");
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error("浏览器不支持剪贴板访问，请手动选择文字复制");
  }
  if (typeof text === "function" && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    let loadError: unknown;
    const contents = Promise.resolve().then(text).then(value => new Blob([value], { type: "text/plain" }), error => {
      loadError = error;
      throw error;
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": contents })]);
    } catch {
      void contents.catch(() => {});
      throw loadError ?? new Error("浏览器拒绝了剪贴板访问，请允许剪贴板权限或手动选择文字复制");
    }
    return;
  }
  const value = typeof text === "function" ? await text() : text;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new Error("浏览器拒绝了剪贴板访问，请允许剪贴板权限或手动选择文字复制");
  }
}

// Copy text and report the outcome with a toast so every copy action gives feedback.
export function copyWithToast(text: string | (() => Promise<string>), successMessage: string) {
  return copyClipboardText(text).then(
    () => toast.success(successMessage),
    (error: Error) => toast.error(error.message),
  );
}
