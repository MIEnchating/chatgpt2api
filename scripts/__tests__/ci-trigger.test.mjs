import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');

test('普通分支推送不触发 CI，PR 创建、更新与关闭事件触发工作流', () => {
  const events = ci.split('on:\n')[1].split('\npermissions:')[0];
  assert.doesNotMatch(events, /^ {2}push:/m);
  assert.match(events, /pull_request:\n {4}types: \[opened, synchronize, closed\]/);
});

test('PR 未合并关闭时两个 CI 任务均跳过', () => {
  for (const name of ['test', 'storage-integration']) {
    const job = ci.split(`  ${name}:\n`)[1].split(/\n {2}[a-z-]+:/)[0];
    assert.match(job, /if: github.event.action != 'closed' \|\| github.event.pull_request.merged == true/);
  }
});

test('所有 CI 检出固定为事件提交，避免合并后分支推进改变检查版本', () => {
  const checkouts = ci.match(/uses: actions\/checkout@[^\n]+\n(?: {8}[^\n]*\n)*/g) ?? [];
  assert.equal(checkouts.length, 2);
  for (const checkout of checkouts) assert.match(checkout, /ref: \$\{\{ github.sha \}\}/);
});

test('标签和手动发布保留前后端及数据库检查', () => {
  assert.match(release, /push:\n {4}tags:\n {6}- "v\*"/);
  assert.match(release, /workflow_dispatch:/);
  for (const command of ['bun run lint', 'bun run test', 'bun run build', 'go test ./...', 'go vet ./...', 'go test -race', 'TestDatabaseBackendIntegration']) {
    assert.ok(release.includes(command), command);
  }
  assert.match(release, /needs: \[build-frontend\]/);
});
