export async function copyClipboardText(text: string): Promise<void> {
  if (!window.isSecureContext) {
    throw new Error("当前 HTTP 页面无法访问剪贴板，请使用 HTTPS 或手动选择文字复制");
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error("浏览器不支持剪贴板访问，请手动选择文字复制");
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new Error("浏览器拒绝了剪贴板访问，请允许剪贴板权限或手动选择文字复制");
  }
}
