import { chmodSync, constants, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Canvas threads must not inherit the user's coding tools, MCP servers or hooks.
export const canvasCodexConfig = {
  approval_policy: "never",
  sandbox_mode: "read-only",
  cli_auth_credentials_store: "file",
  project_doc_max_bytes: 0,
  web_search: "disabled",
  "features.shell_tool": false,
  "features.shell_snapshot": false,
  "features.view_image": false,
  "features.apps": false,
  "features.plugins": false,
  "features.hooks": false,
  "features.multi_agent": false,
  "features.goals": false,
  "features.memories": false,
  "features.browser_use": false,
  "features.browser_use_external": false,
  "features.computer_use": false,
  "features.workspace_dependencies": false,
  "features.skill_search": false,
  "features.skip_host_skill_discovery": true,
  "skills.bundled.enabled": false,
  "skills.include_instructions": false,
  "shell_environment_policy.inherit": "none",
};

export function createCodexRuntime({ environment = process.env, userHome = homedir(), temporaryDirectory = tmpdir() } = {}) {
  const root = mkdtempSync(join(temporaryDirectory, "chatgpt2api-codex-runtime-"));
  const codexHome = join(root, ".codex");
  try {
    mkdirSync(codexHome, { mode: 0o700 });
    // Copy only the login credential, never config, skills, plugins or transcripts.
    try {
      copyFileSync(join(environment.CODEX_HOME || join(userHome, ".codex"), "auth.json"), join(codexHome, "auth.json"), constants.COPYFILE_EXCL);
      chmodSync(join(codexHome, "auth.json"), 0o600);
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const config = Object.entries(canvasCodexConfig).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join("\n");
    writeFileSync(join(codexHome, "config.toml"), config + "\n", { mode: 0o600 });
    const env = {};
    for (const [key, value] of Object.entries(environment)) {
      if (/^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|LC_CTYPE|TERM)$/i.test(key)) env[key] = value;
    }
    Object.assign(env, { HOME: root, USERPROFILE: root, CODEX_HOME: codexHome, TMPDIR: root, TMP: root, TEMP: root });
    return { root, env, close() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
