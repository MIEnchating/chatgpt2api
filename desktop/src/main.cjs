"use strict";
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { defaults, readPreferences, writePreferences } = require("./preferences.cjs");
const { connectionInput, safeWebURL, trustedSettingsSender } = require("./security.cjs");
const { securePreferences, configureSession, configureBrowsingWindow } = require("./browser-policy.cjs");
const { LocalRuntime, healthCheck, checkDevelopmentServices } = require("./runtime.cjs");
const { flushChanges } = require("./flush-changes.cjs");

const development = !app.isPackaged;
app.setName("chatgpt2api");
app.setPath("userData", path.join(app.getPath("appData"), development ? "chatgpt2api-desktop-development" : "chatgpt2api"));
const settingsURL = pathToFileURL(path.join(__dirname, "settings", "index.html")).href;
const preferencesFile = path.join(app.getPath("userData"), "connection.json");
const runtimeRoot = path.join(app.getPath("userData"), "runtime");
let preferences = { ...defaults };
let settingsWindow = null;
let browsingWindow = null;
let runtime = null;
let connectedOrigin = "";
let connecting = false;
let navigating = false;
let quitting = false;
let statusMessage = "";

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const window = settingsWindow || browsingWindow;
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      const held = holdBrowsingWindows();
      try { await flushChanges(held.windows); await runtime?.stop(); app.exit(0); }
      catch (error) { quitting = false; held.release(); dialog.showErrorBox("未能安全退出", error.message); showSettings(); }
    })();
  });
  void app.whenReady().then(initialize).catch((error) => { dialog.showErrorBox("桌面启动失败", error.message); app.quit(); });
}

async function needsLocalPassword() {
  if (development) return false;
  if (!preferences.localInitialized) return true;
  try { await fs.access(path.join(runtimeRoot, "data", "chatgpt2api.db")); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

async function initialize() {
  try { preferences = await readPreferences(preferencesFile); } catch (error) { statusMessage = error.message; }
  runtime = new LocalRuntime({ executable: path.join(process.resourcesPath, "backend", "chatgpt2api.exe"), rootDir: runtimeRoot, onUnexpectedExit(error) { if (!quitting) { statusMessage = error.message; showSettings(); } } });
  ipcMain.handle("desktop:settings", async (event) => {
    requireSettingsSender(event);
    return { ...preferences, needsPassword: await needsLocalPassword(), development, dataDirectory: development ? "使用现有源码服务的数据目录" : runtimeRoot, statusMessage, connecting };
  });
  ipcMain.handle("desktop:connect", async (event, value) => {
    requireSettingsSender(event);
    if (connecting || navigating || quitting) return { ok: false, error: "连接或页面切换正在进行，请稍候" };
    try { await connect(value); return { ok: true }; }
    catch (error) { statusMessage = error.message; return { ok: false, error: error.message }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "连接", submenu: [
      { label: "连接设置…", accelerator: "CmdOrCtrl+,", click: showSettings },
      { label: "返回当前服务", click: () => { if (browsingWindow && connectedOrigin) void navigateSafely(browsingWindow, connectedOrigin); } },
      { label: "在系统浏览器中打开", click: () => { if (safeWebURL(connectedOrigin)) void shell.openExternal(connectedOrigin); } },
      { type: "separator" }, { role: "quit", label: "退出" },
    ] },
    { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" }] },
    { label: "查看", submenu: [{ label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => void navigateSafely(BrowserWindow.getFocusedWindow()) }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" }, { role: "togglefullscreen", label: "全屏" }, ...(development ? [{ role: "toggleDevTools", label: "开发者工具" }] : [])] },
  ]));
  showSettings();
  if (!statusMessage && (preferences.mode === "remote" && preferences.remoteURL || preferences.mode === "local" && !await needsLocalPassword())) {
    try { await connect({ mode: preferences.mode, remoteURL: preferences.remoteURL }); }
    catch (error) { statusMessage = error.message; if (settingsWindow) await settingsWindow.reload(); }
  }
}

function requireSettingsSender(event) {
  if (!trustedSettingsSender(event, settingsWindow?.webContents, settingsURL)) throw new Error("此页面无权修改桌面连接设置");
}

function holdBrowsingWindows(excluded) {
  const windows = BrowserWindow.getAllWindows().filter((window) => window !== excluded && window !== settingsWindow && !window.isDestroyed());
  for (const window of windows) window.setEnabled(false);
  return { windows, release() { for (const window of windows) if (!window.isDestroyed()) window.setEnabled(true); } };
}

async function navigateSafely(window, url) {
  if (!window || window.isDestroyed() || connecting || navigating || quitting) return;
  if (window === settingsWindow) { window.reload(); return; }
  navigating = true;
  const held = holdBrowsingWindows();
  try {
    await flushChanges(held.windows);
    if (quitting || window.isDestroyed()) return;
    if (url) await window.loadURL(url);
    else window.reload();
  } catch (error) { dialog.showErrorBox("未能重新加载页面", error.message); }
  finally { navigating = false; if (!quitting) held.release(); }
}

function showSettings() {
  if (quitting) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({ title: "chatgpt2api · 连接设置", width: 640, height: 740, minWidth: 540, minHeight: 640, backgroundColor: "#f7f8fa", autoHideMenuBar: true, webPreferences: { ...securePreferences, partition: "desktop-settings", preload: path.join(__dirname, "preload.cjs") } });
  settingsWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  settingsWindow.webContents.session.setPermissionCheckHandler(() => false);
  settingsWindow.webContents.on("will-frame-navigate", (event) => { if (event.url !== settingsURL) event.preventDefault(); });
  settingsWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  settingsWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.on("closed", () => { settingsWindow = null; });
  void settingsWindow.loadURL(settingsURL);
}

async function connect(value) {
  connecting = true;
  try {
    const input = connectionInput(value, value?.mode === "local" && await needsLocalPassword());
    let origin;
    if (input.mode === "local") origin = development ? await checkDevelopmentServices() : await runtime.start(input.adminPassword);
    else { await healthCheck(input.remoteURL); origin = input.remoteURL; }
    input.adminPassword = "";
    if (quitting) throw new Error("正在退出桌面应用");
    const partition = input.mode === "local" ? "persist:local" : `persist:remote-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    configureSession(session.fromPartition(partition), origin, async (contents, permission, requestingOrigin) => {
      const owner = BrowserWindow.fromWebContents(contents);
      if (!owner || owner.isDestroyed()) return false;
      const localNetwork = permission === "local-network";
      const result = await dialog.showMessageBox(owner, {
        type: "question", buttons: ["允许", "拒绝"], defaultId: 1, cancelId: 1, noLink: true,
        title: localNetwork ? "访问本机服务" : "读取剪贴板",
        message: localNetwork ? "允许当前服务连接本机和局域网服务？" : "允许当前服务读取剪贴板以完成粘贴？",
        detail: `${requestingOrigin}\n${localNetwork ? "用于 Codex 本机桥、局域网存储等连接。授权仅在本次连接期间有效。" : "仅为本次粘贴临时授权，不会持续允许读取剪贴板。"}`,
      });
      return result.response === 0;
    });
    const next = new BrowserWindow({ title: `chatgpt2api · ${origin}`, width: 1440, height: 960, minWidth: 960, minHeight: 680, show: false, backgroundColor: "#ffffff", webPreferences: { ...securePreferences, partition } });
    configureBrowsingWindow(next, partition);
    next.on("close", (event) => { if (browsingWindow === next) { event.preventDefault(); if (!quitting) app.quit(); } });
    let held;
    try {
      await next.loadURL(origin);
      held = holdBrowsingWindows(next);
      await flushChanges(held.windows);
      if (quitting) throw new Error("正在退出桌面应用");
      if (input.mode === "remote") await runtime.stop();
      preferences = await writePreferences(preferencesFile, { mode: input.mode, remoteURL: input.remoteURL || preferences.remoteURL, localInitialized: preferences.localInitialized || input.mode === "local" && !development });
    } catch (error) { next.destroy(); if (!quitting) held?.release(); throw error; }
    if (quitting) { next.destroy(); throw new Error("正在退出桌面应用"); }
    const previous = browsingWindow;
    browsingWindow = next;
    next.on("closed", () => { if (browsingWindow === next) browsingWindow = null; });
    connectedOrigin = origin;
    next.show();
    previous?.destroy();
    held?.release();
    statusMessage = "";
    settingsWindow?.close();
  } finally { connecting = false; }
}
