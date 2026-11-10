import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasCodexConfig, createCodexRuntime } from "../codex-runtime.mjs";
import { CodexClient } from "../codex-client.mjs";

test("isolates Codex configuration and passes only allowed environment variables", (t) => {
  const root = mkdtempSync(join(tmpdir(), "canvas-runtime-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "auth.json"), '{"testCredential":"synthetic-only"}', { mode: 0o600 });
  writeFileSync(join(source, "config.toml"), 'developer_instructions = "HOST_CONFIG_MUST_NOT_LEAK"');
  mkdirSync(join(source, "skills"));
  writeFileSync(join(source, "AGENTS.md"), "HOST_INSTRUCTIONS_MUST_NOT_LEAK");
  const runtime = createCodexRuntime({ temporaryDirectory: root, userHome: root, environment: {
    CODEX_HOME: source, HOME: "/private/home", USERPROFILE: "/private/home", PATH: "/test/bin", SystemRoot: "C:\\Windows", LANG: "en_US.UTF-8",
    CANVAS_AGENT_TOKEN: "synthetic-bridge-token", ADMIN_PASSWORD: "synthetic-password", DATABASE_URL: "synthetic-database", OPENAI_API_KEY: "synthetic-key",
    NODE_OPTIONS: "--require /untrusted/module", BASH_ENV: "/untrusted/profile", HTTP_PROXY: "http://synthetic-proxy",
  } });
  t.after(() => runtime.close());
  assert.deepEqual(Object.keys(runtime.env).sort(), ["PATH", "SystemRoot", "LANG", "HOME", "USERPROFILE", "CODEX_HOME", "TMPDIR", "TMP", "TEMP"].sort());
  assert.equal(runtime.env.PATH, "/test/bin");
  assert.equal(runtime.env.HOME, runtime.root);
  assert.equal(runtime.env.USERPROFILE, runtime.root);
  assert.equal(runtime.env.CODEX_HOME, join(runtime.root, ".codex"));
  assert.deepEqual(readdirSync(runtime.env.CODEX_HOME).sort(), ["auth.json", "config.toml"]);
  assert.equal(readFileSync(join(runtime.env.CODEX_HOME, "auth.json"), "utf8"), '{"testCredential":"synthetic-only"}');
  assert.equal(readFileSync(join(source, "config.toml"), "utf8"), 'developer_instructions = "HOST_CONFIG_MUST_NOT_LEAK"');
  const config = readFileSync(join(runtime.env.CODEX_HOME, "config.toml"), "utf8");
  assert.ok(!config.includes("HOST_CONFIG_MUST_NOT_LEAK"));
  assert.equal(canvasCodexConfig["features.shell_tool"], false);
  assert.equal(canvasCodexConfig["features.view_image"], false);
  assert.equal(canvasCodexConfig["features.hooks"], false);
  assert.equal(canvasCodexConfig["features.skip_host_skill_discovery"], true);
  runtime.close();
  assert.equal(existsSync(runtime.root), false);
  assert.equal(existsSync(join(source, "auth.json")), true);
});

test("requires an explicit isolated environment before spawning Codex", () => {
  assert.throws(() => new CodexClient({ cwd: "/tmp", onMessage() {}, spawnProcess() { assert.fail("must not spawn"); } }), /独立/);
});

test("a missing file credential does not import the user's other configuration", (t) => {
  const root = mkdtempSync(join(tmpdir(), "canvas-runtime-no-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createCodexRuntime({ environment: {}, userHome: root, temporaryDirectory: root });
  t.after(() => runtime.close());
  assert.deepEqual(readdirSync(runtime.env.CODEX_HOME), ["config.toml"]);
});
