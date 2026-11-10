import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');

test('普通分支推送不触发 CI，仅 PR 创建、更新与关闭事件触发工作流', () => {
  const events = ci.split('on:\n')[1].split('\npermissions:')[0];
  assert.doesNotMatch(events, /^ {2}push:/m);
  assert.match(events, /pull_request:\n {4}types: \[opened, synchronize, closed\]/);
});

test('两个 CI 任务在 PR 合并时运行，关闭未合并的 PR 时跳过', () => {
  for (const name of ['test', 'storage-integration']) {
    const job = ci.split(`  ${name}:\n`)[1].split(/\n {2}[a-z-]+:/)[0];
    assert.match(job, /if: github\.event\.action != 'closed' \|\| github\.event\.pull_request\.merged == true/);
  }
});

test('所有 CI 检出固定为事件提交，避免合并后分支推进改变检查版本', () => {
  const checkouts = ci.match(/uses: actions\/checkout@[^\n]+\n(?: {8}[^\n]*\n)*/g) ?? [];
  assert.equal(checkouts.length, 2);
  for (const checkout of checkouts) assert.match(checkout, /ref: \$\{\{ github.sha \}\}/);
});

test('标签和手动发布只构建发布，不重复执行 PR 校验或等待 CI', () => {
  assert.match(release, /push:\n {4}tags:\n {6}- "v\*"/);
  assert.match(release, /workflow_dispatch:/);
  for (const name of ['release.yml', 'windows-desktop.yml']) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(workflow, /(?:bun|npm) (?:run )?(?:lint|test)\b|go (?:test|vet)\b|gofmt\b|TestDatabaseBackendIntegration/);
    assert.doesNotMatch(workflow, /^ {4}services:|workflow_run:|workflow_call:|gh (?:run|pr) (?:watch|checks)|check-runs|check-suites/m);
  }
  assert.match(release, /run: bun run build/);
  assert.match(release, /args: release --clean/);
  assert.match(release, /run: bash scripts\/validate-release-notes\.sh "\$RELEASE_TAG"/);
  assert.match(release, /needs: \[build-frontend\]/);
});

test('前后端、Agent runtime、桌面与数据库校验集中在 PR CI', () => {
  for (const command of ['bun run lint', 'bun run test', 'bun run build', 'go test ./...', 'go vet ./...', 'go test -race', 'TestDatabaseBackendIntegration']) {
    assert.ok(ci.includes(command), command);
  }
  for (const directory of ['agent-runtime', 'desktop']) {
    assert.ok(ci.includes(`working-directory: ${directory}\n        run: npm test`), directory);
  }
  const databaseJob = ci.split('  storage-integration:\n')[1];
  assert.ok(databaseJob.includes('TestAgentExecutionHistorySurvivesDatabaseReopen'));
  assert.ok(databaseJob.includes('TestCanvasAgentSDKSessionPersistsAcrossDatabaseReopen'));
  assert.match(databaseJob, /working-directory: agent-runtime\n        run: npm ci --ignore-scripts/);
});

test('第三方 Action 固定为完整提交 SHA 并在行尾注释版本', () => {
  for (const name of ['ci.yml', 'release.yml', 'windows-desktop.yml']) {
    const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    for (const line of text.split('\n')) {
      const match = line.match(/uses: ([^@\s]+)@(\S+)/);
      if (!match || match[1].startsWith('actions/')) continue;
      assert.match(match[2], /^[0-9a-f]{40}$/, `${name}: ${match[1]}`);
      assert.match(line, / # v\d+\.\d+\.\d+$/, `${name}: ${match[1]}`);
    }
  }
});

test('发布任务的检出不保留凭据', () => {
  const text = release.replaceAll('\r\n', '\n');
  assert.match(text, /ref: \$\{\{ needs\.build-frontend\.outputs\.release_tag \}\}\n {10}persist-credentials: false/);
});

test('Dependabot 每周更新 GitHub Actions', () => {
  const text = readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.match(text, /package-ecosystem: "github-actions"\n {4}directory: "\/"\n {4}schedule:\n {6}interval: "weekly"/);
});

test('桌面安装包签名由 secrets 配置，校验和作为独立 artifact 发布', () => {
  const text = readFileSync(new URL('../../.github/workflows/windows-desktop.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.match(text, /CSC_LINK: \$\{\{ secrets\.WINDOWS_CSC_LINK \}\}/);
  assert.match(text, /CSC_KEY_PASSWORD: \$\{\{ secrets\.WINDOWS_CSC_KEY_PASSWORD \}\}/);
  assert.match(text, /path: desktop\/dist\/\*-setup\.exe\n/);
  assert.match(text, /-sha256\n {10}path: desktop\/dist\/\*-setup\.exe\.sha256\n/);
});
