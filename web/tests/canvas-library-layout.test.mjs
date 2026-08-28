import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/app/canvas/library-page.tsx", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("../src/app/app-shell.tsx", import.meta.url), "utf8");

test("every page shares the same full-width application shell", () => {
  assert.match(appShellSource, /w-full max-w-none flex-col gap-3/);
  assert.doesNotMatch(appShellSource, /max-w-\[1480px\]/);
  assert.doesNotMatch(appShellSource, /useLocation/);
});

test("canvas project cards use a stable responsive four-column wide-screen grid", () => {
  assert.match(source, /data-canvas-project-content className="w-full px-4 py-4 sm:px-6 sm:py-6"/);
  assert.doesNotMatch(source, /max-w-\[1600px\]/);
  assert.match(source, /data-canvas-project-grid/);
  assert.match(source, /grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4/);
  assert.doesNotMatch(source, /auto-fill/);
});

test("canvas project card content keeps compact explicit spacing", () => {
  assert.match(source, /data-canvas-project-card/);
  assert.match(source, /data-selected=\{selectedProjectIDs\.has\(project\.id\)\}/);
  assert.match(source, /data-interaction="trigger"/);
  assert.match(source, /className="interactive-card group/);
  assert.match(source, /className="interactive-card-trigger min-w-0 flex-1/);
  assert.match(source, /className="selection-control"/);
  assert.match(source, /mb-3 flex min-h-5/);
  assert.match(source, /mt-3 flex min-w-0 flex-wrap/);
  assert.match(source, /mt-4 flex items-center justify-end/);
});
