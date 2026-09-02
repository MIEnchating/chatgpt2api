import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apiSource = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const usersSource = readFileSync(new URL("../src/app/users/page.tsx", import.meta.url), "utf8");

test("managed users preserve explicit usage-statistics availability", () => {
  assert.match(apiSource, /usage_stats_available:\s*boolean/);
  assert.match(apiSource, /usage_stats_available:\s*data\.usage_stats_available\s*!==\s*false/);
  assert.match(usersSource, /setUsageStatsAvailable\(usersData\.usage_stats_available\)/);
});

test("users page distinguishes unavailable statistics from zero usage", () => {
  assert.match(usersSource, /usageStatsAvailable\s*\?\s*\(/);
  assert.match(usersSource, /统计暂时不可用/);
  assert.match(usersSource, /用户数据与操作不受影响/);
  assert.match(usersSource, /disabled=\{field === "call_count" && !usageStatsAvailable\}/);
});
