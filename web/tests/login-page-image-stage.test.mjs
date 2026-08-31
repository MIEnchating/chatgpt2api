import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/login-page-image-stage.tsx", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../src/components/use-login-page-image-state.ts", import.meta.url), "utf8");

test("login image fallback is scoped to the URL that failed", () => {
  assert.match(source, /useLoginPageImageState/);
  assert.match(stateSource, /const \[failedSrc, setFailedSrc\] = useState\(""\)/);
  assert.match(stateSource, /const currentSrc = failedSrc === resolvedSrc \? fallbackSrc : resolvedSrc/);
  assert.match(stateSource, /setFailedSrc\(resolvedSrc\)/);
  assert.doesNotMatch(stateSource, /fallbackActive/);
});
