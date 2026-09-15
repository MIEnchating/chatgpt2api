"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { serverOrigin, safeWebURL, safeDownloadURL, trustedSettingsSender, connectionInput } = require("../src/security.cjs");
const { readPreferences, writePreferences } = require("../src/preferences.cjs");
const { configureBrowsingWindow, configureSession } = require("../src/browser-policy.cjs");
test("server settings reject credentials, paths, and native schemes", () => {
  assert.equal(serverOrigin(" https://example.test:443/ "), "https://example.test"); assert.equal(serverOrigin("http://127.0.0.1:8090"), "http://127.0.0.1:8090");
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "ms-settings:about", "https://user:pass@example.test", "https://example.test/api", "https://example.test/?token=secret", "https://example.test/#login", "data:text/html,code"]) assert.throws(() => serverOrigin(value));
  assert.equal(safeWebURL("https://example.test/sso/callback?code=normal"), true); assert.equal(safeWebURL("cmd://run"), false);
});
test("only the exact local settings top frame can invoke management IPC", () => {
  const url = "file:///app/settings/index.html"; const mainFrame = { url }; const contents = { mainFrame, isDestroyed: () => false };
  assert.equal(trustedSettingsSender({ sender: contents, senderFrame: mainFrame }, contents, url), true);
  for (const frame of [{ url }, { url: "https://example.test" }, { url: `${url}?spoof=1` }]) assert.equal(trustedSettingsSender({ sender: contents, senderFrame: frame }, contents, url), false);
  assert.equal(trustedSettingsSender({ sender: {}, senderFrame: mainFrame }, contents, url), false); mainFrame.url = "https://evil.test"; assert.equal(trustedSettingsSender({ sender: contents, senderFrame: mainFrame }, contents, url), false);
});
test("first boot requires a password and remote connections never carry one", () => {
  assert.throws(() => connectionInput({ mode: "local", adminPassword: "short" }, true), /12/); assert.throws(() => connectionInput({ mode: "remote", remoteURL: "https://example.test", executable: "other.exe" }, false));
  assert.equal(connectionInput({ mode: "local", adminPassword: "strong-password" }, true).adminPassword, "strong-password"); assert.equal(connectionInput({ mode: "remote", remoteURL: "https://example.test", adminPassword: "ignored" }, false).adminPassword, "");
});
test("bootstrap passwords respect the backend UTF-8 byte limit", () => {
  for (const password of ["a".repeat(73), "汉".repeat(25)]) assert.throws(() => connectionInput({ mode: "local", adminPassword: password }, true), /72/);
  for (const password of ["a".repeat(72), "汉".repeat(24)]) assert.equal(connectionInput({ mode: "local", adminPassword: password }, true).adminPassword, password);
});
test("preferences replace atomically and never persist plaintext bootstrap secrets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-preferences-test-")); t.after(() => fs.rm(root, { recursive: true, force: true })); const file = path.join(root, "connection.json"); assert.equal((await readPreferences(file)).localInitialized, false);
  await writePreferences(file, { mode: "local", localInitialized: true, adminPassword: "never-persist-this" }); await writePreferences(file, { mode: "remote", remoteURL: "https://example.test", localInitialized: true, adminPassword: "never-persist-this" });
  const text = await fs.readFile(file, "utf8"); assert.equal(text.includes("password"), false); assert.equal(text.includes("never-persist"), false); assert.deepEqual(await readPreferences(file), { version: 1, mode: "remote", remoteURL: "https://example.test", localInitialized: true }); assert.deepEqual(await fs.readdir(root), ["connection.json"]);
});
test("browser popups stay sandboxed and native navigation is blocked", () => {
  const contents = new EventEmitter(); contents.getURL = () => "https://app.test"; contents.setWindowOpenHandler = (handler) => { contents.open = handler; }; configureBrowsingWindow({ webContents: contents, setTitle() {} }, "persist:test");
  assert.deepEqual(contents.open({ url: "file:///secret" }), { action: "deny" }); const popup = contents.open({ url: "https://login.test" }); assert.equal(popup.action, "allow"); const prefs = popup.overrideBrowserWindowOptions.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.preload, undefined); assert.equal(prefs.partition, "persist:test");
  let blocked = false; contents.emit("will-frame-navigate", { url: "ms-settings:privacy", preventDefault() { blocked = true; } }); assert.equal(blocked, true); blocked = false; contents.emit("will-frame-navigate", { url: "https://login.test/sso", preventDefault() { blocked = true; } }); assert.equal(blocked, false);
});
test("downloads use save dialogs and permissions cannot grant filesystem or shell access", () => {
  const session = new EventEmitter(); session.setPermissionCheckHandler = (handler) => { session.check = handler; }; session.setPermissionRequestHandler = (handler) => { session.request = handler; }; configureSession(session, "https://app.test");
  const contents = { getURL: () => "https://app.test/canvas", isDestroyed: () => false }; assert.equal(session.check(contents, "clipboard-sanitized-write", "https://app.test", { isMainFrame: true }), true); assert.equal(session.check(contents, "fileSystem", "https://app.test"), false); assert.equal(session.check(contents, "openExternal", "https://app.test"), false);
  let options; const item = { getURL: () => "blob:https://app.test/random", getFilename: () => "../../picture.png", setSaveDialogOptions(value) { options = value; } }; session.emit("will-download", { preventDefault() { throw new Error("unexpected block"); } }, item, contents); assert.equal(options.defaultPath, "picture.png"); assert.ok(options.properties.includes("showOverwriteConfirmation"));
  assert.equal(safeDownloadURL("blob:https://foreign.test/id", contents.getURL()), false); assert.equal(safeDownloadURL("file:///secret", contents.getURL()), false);
});


test("local network and clipboard reading need native confirmation scoped to the connected main frame", async () => {
  const session = new EventEmitter(); session.setPermissionCheckHandler = (handler) => { session.check = handler; }; session.setPermissionRequestHandler = (handler) => { session.request = handler; };
  const prompts = []; let accept = false;
  configureSession(session, "https://app.test", async (_contents, group, origin) => { prompts.push([group, origin]); return accept; });
  const contents = { getURL: () => "https://app.test/canvas", isDestroyed: () => false };
  const details = { isMainFrame: true, requestingUrl: "https://app.test/canvas" };
  const request = (permission, requestDetails = details) => new Promise((resolve) => session.request(contents, permission, resolve, requestDetails));
  assert.equal(session.check(contents, "loopback-network", "https://app.test", details), false);
  assert.equal(await request("loopback-network"), false); accept = true;
  assert.equal(await request("local-network-access"), true);
  assert.equal(session.check(contents, "loopback-network", "https://app.test", details), true);
  assert.equal(session.check(contents, "loopback-network", "https://foreign.test", details), false);
  assert.equal(await request("clipboard-read", { ...details, isMainFrame: false }), false);
  assert.equal(await request("clipboard-read"), true);
  assert.deepEqual(prompts, [["local-network", "https://app.test"], ["local-network", "https://app.test"], ["clipboard-read", "https://app.test"]]);
  configureSession(session, "https://app.test");
  assert.equal(session.check(contents, "loopback-network", "https://app.test", details), false);
});
