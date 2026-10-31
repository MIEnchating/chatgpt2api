import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const panelSource = read("../src/app/canvas/canvas-agent-panel.tsx");
const runSettingsSource = read("../src/app/canvas/canvas-agent-run-settings.tsx");

test("history rename input ignores Enter while an IME composition is active", () => {
  const start = panelSource.indexOf('aria-label="对话名称"');
  assert.ok(start >= 0);
  const input = panelSource.slice(start, panelSource.indexOf("onBlur=", start));
  const guard = input.indexOf("event.nativeEvent.isComposing");
  assert.ok(guard >= 0, "rename onKeyDown must check isComposing");
  assert.ok(guard < input.indexOf('event.key === "Enter"'), "composition guard must run before the Enter handler");
});

test("run settings dialog closes its own state when a run starts", () => {
  assert.match(runSettingsSource, /useEffect\(\(\) => \{ if \(busy\) setOpen\(false\); \}, \[busy\]\)/);
});
