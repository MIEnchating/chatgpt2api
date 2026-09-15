"use strict";
const path = require("node:path");
const { safeWebURL, safeDownloadURL } = require("./security.cjs");
const securePreferences = Object.freeze({ contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true });
const configuredDownloads = new WeakSet();

function configureSession(session, origin, confirmPermission = async () => false) {
  const grants = new Map();
  const pending = new Map();
  const isTrustedFrame = (contents, requestingOrigin, details) => {
    if (!contents || contents.isDestroyed() || details?.isMainFrame !== true) return false;
    try { return new URL(contents.getURL()).origin === origin && new URL(requestingOrigin).origin === origin; } catch { return false; }
  };
  const permissionGroup = (permission) => {
    if (["local-network", "local-network-access", "loopback-network"].includes(permission)) return "local-network";
    if (["clipboard-read", "deprecated-sync-clipboard-read"].includes(permission)) return "clipboard-read";
    return "";
  };
  const granted = (group) => (grants.get(group) || 0) > Date.now();
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!isTrustedFrame(contents, requestingOrigin, details)) return false;
    return ["clipboard-sanitized-write", "fullscreen"].includes(permission) || granted(permissionGroup(permission));
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!isTrustedFrame(contents, details.requestingUrl, details)) { callback(false); return; }
    if (["clipboard-sanitized-write", "fullscreen"].includes(permission)) { callback(true); return; }
    const group = permissionGroup(permission);
    if (!group) { callback(false); return; }
    if (granted(group)) { callback(true); return; }
    if (!pending.has(group)) {
      pending.set(group, Promise.resolve().then(() => confirmPermission(contents, group, origin)).catch(() => false).finally(() => pending.delete(group)));
    }
    void pending.get(group).then((accepted) => {
      const allow = accepted === true && isTrustedFrame(contents, details.requestingUrl, details);
      if (allow) grants.set(group, group === "clipboard-read" ? Date.now() + 5000 : Infinity);
      callback(allow);
    });
  });
  if (configuredDownloads.has(session)) return;
  configuredDownloads.add(session);
  session.on("will-download", (event, item, contents) => {
    if (!contents || contents.isDestroyed() || !safeDownloadURL(item.getURL(), contents.getURL())) { event.preventDefault(); return; }
    const filename = path.basename(item.getFilename().replaceAll("\\", "/"));
    item.setSaveDialogOptions({ title: "保存下载文件", defaultPath: filename, properties: ["showOverwriteConfirmation", "createDirectory"] });
  });
}

function configureBrowsingWindow(window, partition) {
  const contents = window.webContents;
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => { if (!safeWebURL(event.url) && event.url !== "about:blank") event.preventDefault(); });
  contents.on("will-redirect", (event) => { if (!safeWebURL(event.url)) event.preventDefault(); });
  const title = (_event, url) => {
    if (safeWebURL(url)) window.setTitle(`chatgpt2api · ${new URL(url).origin}`);
  };
  contents.on("did-navigate", title);
  contents.on("page-title-updated", (event) => { event.preventDefault(); title(null, contents.getURL()); });
  contents.setWindowOpenHandler(({ url }) => safeWebURL(url) ? { action: "allow", overrideBrowserWindowOptions: { width: 1100, height: 800, autoHideMenuBar: true, webPreferences: { ...securePreferences, partition } } } : { action: "deny" });
  contents.on("did-create-window", (child) => configureBrowsingWindow(child, partition));
}
module.exports = { securePreferences, configureSession, configureBrowsingWindow };
