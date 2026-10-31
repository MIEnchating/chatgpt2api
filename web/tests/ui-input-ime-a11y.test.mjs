import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CR = String.fromCharCode(13);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').split(CR).join('');
const inputTagSource = read('../src/components/ui/input-tag.tsx');
const inputSource = read('../src/components/ui/input.tsx');

test('input tag ignores the Enter key that confirms an IME candidate in Safari', () => {
  assert.match(inputTagSource, /composingRef[.]current/);
  assert.match(inputTagSource, /event[.]nativeEvent[.]isComposing/);
  assert.match(inputTagSource, /event[.]keyCode === 229/);
});

test('password visibility toggle does not pair a changing label with aria-pressed', () => {
  assert.doesNotMatch(inputSource, /aria-pressed/);
  assert.match(inputSource, /aria-label=[{]passwordVisible/);
});
