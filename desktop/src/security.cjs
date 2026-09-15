"use strict";
function serverOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请输入服务器地址");
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("服务器地址须为完整的 HTTP 或 HTTPS 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("服务器地址只需包含 HTTP/HTTPS 域名和端口，不能包含密码、路径或参数");
  return url.origin;
}
function safeWebURL(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function safeDownloadURL(value, currentURL) {
  if (safeWebURL(value)) return true;
  try { const url = new URL(value); return url.protocol === "data:" || (url.protocol === "blob:" && url.origin === new URL(currentURL).origin); } catch { return false; }
}
function trustedSettingsSender(event, contents, settingsURL) {
  return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === settingsURL);
}
function connectionInput(value, needsPassword) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["mode", "remoteURL", "adminPassword"].includes(key))) throw new Error("连接设置无效");
  if (value.mode !== "local" && value.mode !== "remote") throw new Error("请选择连接方式");
  const remoteURL = value.mode === "remote" ? serverOrigin(value.remoteURL) : "";
  let adminPassword = "";
  if (value.mode === "local" && needsPassword) {
    if (typeof value.adminPassword !== "string" || value.adminPassword.length < 12 || Buffer.byteLength(value.adminPassword, "utf8") > 72 || value.adminPassword.includes("\0")) throw new Error("管理员密码至少 12 个字符，且不能超过 72 个 UTF-8 字节（汉字通常占 3 字节）");
    adminPassword = value.adminPassword;
  }
  return { mode: value.mode, remoteURL, adminPassword };
}
module.exports = { serverOrigin, safeWebURL, safeDownloadURL, trustedSettingsSender, connectionInput };
