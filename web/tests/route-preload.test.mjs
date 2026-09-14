import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createElement, Suspense } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { matchRoutes } from "react-router-dom";
import ts from "typescript";

const require = createRequire(import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadSource(path, resolveImport = require) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: resolveImport }, { filename: path });
  return exports;
}

const authSession = loadSource("../src/lib/auth-session.ts");

function userSession(menuPaths = []) {
  return {
    key: "route-test",
    role: "user",
    subjectId: "user:route-test",
    name: "Route Test",
    creationConcurrentLimit: 1,
    creationRpmLimit: 1,
    menuPaths,
    apiPermissions: [],
    menus: [],
  };
}

function loadRoutes(session, loadPage = (name) => ({ default: () => createElement("p", null, name) })) {
  const importedPages = [];
  const routes = loadSource("../src/app/route-config.tsx", (name) => {
    if (name === "@/lib/auth-session") return authSession;
    if (name === "@/lib/session") return { getCachedAuthSession: () => session };
    // CommonJS transpilation resolves dynamic imports through require in a promise.
    if (name.startsWith("@/app/")) {
      importedPages.push(name);
      return loadPage(name, importedPages.length);
    }
    return require(name);
  });
  return { ...routes, importedPages };
}

test("registering routes does not import their page modules", async () => {
  const { appRoutes, importedPages } = loadRoutes(userSession(["/studio"]));
  assert.ok(matchRoutes(appRoutes, "/studio"));
  await flush();
  assert.deepEqual(importedPages, []);
});

test("authorized menu intentions preload the matching page module", async () => {
  const cases = [
    ["/assets", ["/assets"], "@/app/assets/page"],
    ["/studio?conversation=example#latest", ["/studio"], "@/app/image/page"],
    ["/canvas", ["/canvas"], "@/app/canvas/library-route"],
    ["/canvas/editor", ["/canvas"], "@/app/canvas/route"],
    ["/canvas/project-123", ["/canvas"], "@/app/canvas/route"],
    ["/profile", [], "@/app/profile/page"],
  ];
  for (const [pathname, permissions, expectedModule] of cases) {
    const { preloadRoute, importedPages } = loadRoutes(userSession(permissions));
    assert.equal(preloadRoute(pathname), undefined);
    await flush();
    assert.deepEqual(importedPages, [expectedModule], pathname);
  }

  const { preloadRoute, importedPages } = loadRoutes({ ...userSession(), role: "admin" });
  preloadRoute("/settings");
  await flush();
  assert.deepEqual(importedPages, ["@/app/settings/page"]);
});

test("protected routes do not preload without a verified authorized session", async () => {
  for (const session of [undefined, null, userSession(["/assets"])]) {
    const { preloadRoute, importedPages } = loadRoutes(session);
    for (const pathname of ["/studio", "/canvas", "/canvas/editor", "/canvas/project-123", "/settings"]) {
      preloadRoute(pathname);
    }
    if (!session) preloadRoute("/profile");
    await flush();
    assert.deepEqual(importedPages, []);
  }
});

test("a failed speculative import is handled and lazy navigation retries successfully", async () => {
  const { appRoutes, preloadRoute, importedPages } = loadRoutes(userSession(["/settings"]), (name, attempt) => {
    if (attempt === 1) throw new Error("temporary module download failure");
    return { default: () => createElement("p", null, name) };
  });

  assert.equal(preloadRoute("/settings"), undefined);
  await flush();
  assert.deepEqual(importedPages, ["@/app/settings/page"]);

  const element = matchRoutes(appRoutes, "/settings").at(-1).route.element;
  const pendingMarkup = renderToString(createElement(Suspense, { fallback: "Loading settings" }, element));
  assert.ok(pendingMarkup.includes("Loading settings"));
  await flush();
  assert.deepEqual(importedPages, ["@/app/settings/page", "@/app/settings/page"]);
  assert.equal(renderToStaticMarkup(element), "<p>@/app/settings/page</p>");
});
