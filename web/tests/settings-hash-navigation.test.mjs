import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { canAccessPath } from "../src/lib/auth-session.ts";

function pageHandler(file, name) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/app/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression);
  return new Function(`${ts.transpile(`const handler = ${expression}`, { target: ts.ScriptTarget.ES2022 })};return handler;`)();
}

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/settings-navigation.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports,
  require: name => name === "@/lib/auth-session" ? { canAccessPath } : new Proxy({}, { get: (_, key) => String(key) }),
});
const { personalSettingsSections, getSystemSettingsSections } = exports;
const session = (role, menuPaths = []) => ({ role, menuPaths });

test("settings navigation respects route access and administrator-only sections", () => {
  assert.equal(personalSettingsSections.length, 5);
  assert.equal(getSystemSettingsSections(session("user")).length, 0);
  const delegated = getSystemSettingsSections(session("user", ["/settings"]));
  assert.equal(delegated.length, 6);
  assert.ok(delegated.every(item => !item.adminOnly));
  const admin = getSystemSettingsSections(session("admin"));
  assert.equal(admin.length, 9);
  assert.equal(new Set(admin.map(item => item.id)).size, admin.length);
  assert.ok(admin.every(item => item.href.endsWith(`#${item.id}`)));
});

test("system settings fragments follow the sections allowed for the current account", () => {
  const resolve = pageHandler("settings/page.tsx", "settingsSectionFromHash");
  const admin = getSystemSettingsSections(session("admin"));
  const delegated = getSystemSettingsSections(session("user", ["/settings"]));
  for (const item of admin) assert.equal(resolve(`#${item.id}`, admin), item.id);
  assert.equal(resolve("#announcements", delegated), "config");
  assert.equal(resolve("#model%2Dconfig", admin), "model-config");
  assert.equal(resolve("#database-connection", admin), "config");
  assert.equal(resolve("#image-storage-governance", admin), "media-storage-governance");
  for (const hash of ["", "#unknown", "#%E0%A4%A"]) assert.equal(resolve(hash, admin), "config");
});

test("personal settings fragments preserve direct links and include appearance", () => {
  const resolve = pageHandler("profile/page.tsx", "profileSectionFromHash");
  for (const item of personalSettingsSections) assert.equal(resolve(`#${item.id}`), item.id);
  for (const hash of ["", "#unknown", "#%E0%A4%A"]) assert.equal(resolve(hash), "account");
});
