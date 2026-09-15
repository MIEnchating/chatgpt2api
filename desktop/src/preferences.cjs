"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { serverOrigin } = require("./security.cjs");
const defaults = Object.freeze({ version: 1, mode: "local", remoteURL: "", localInitialized: false });
async function readPreferences(filename) {
  let raw;
  try { raw = JSON.parse(await fs.readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { ...defaults }; throw new Error("连接设置无法读取，请从连接设置重新保存"); }
  if (!raw || raw.version !== 1 || !["local", "remote"].includes(raw.mode) || typeof raw.localInitialized !== "boolean") throw new Error("连接设置格式无效，请重新保存");
  return { version: 1, mode: raw.mode, remoteURL: raw.remoteURL ? serverOrigin(raw.remoteURL) : "", localInitialized: raw.localInitialized };
}
async function writePreferences(filename, value) {
  const persisted = { version: 1, mode: value.mode, remoteURL: value.remoteURL ? serverOrigin(value.remoteURL) : "", localInitialized: value.localInitialized === true };
  if (!["local", "remote"].includes(persisted.mode)) throw new Error("连接方式无效");
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
  return persisted;
}
module.exports = { defaults, readPreferences, writePreferences };
