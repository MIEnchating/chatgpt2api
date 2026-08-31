import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/login-page-image-stage.tsx", import.meta.url), "utf8");

test("login image fallback is scoped to the URL that failed", () => {
  assert.match(source, /const \[failedSrc, setFailedSrc\] = useState\(""\)/);
  assert.match(source, /const currentSrc = failedSrc === resolvedSrc \? fallbackSrc : resolvedSrc/);
  assert.match(source, /setFailedSrc\(resolvedSrc\)/);
  assert.doesNotMatch(source, /fallbackActive/);
});
