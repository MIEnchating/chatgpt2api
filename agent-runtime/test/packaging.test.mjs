import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Every module imported by the worker must reach each distributable runtime.
test('archives, Docker and desktop packages include the complete LangGraph runtime', () => {
  const runtime = new URL('../', import.meta.url);
  const root = new URL('../../', import.meta.url);
  const modules = readdirSync(runtime).filter(name => name.endsWith('.mjs'));
  const release = readFileSync(new URL('.goreleaser.yaml', root), 'utf8');
  const archive = release.split('checksum:')[0];
  const docker = release.split('extra_files:')[1].split('images:')[0];
  const desktop = JSON.parse(readFileSync(new URL('desktop/package.json', root), 'utf8'));
  const filter = desktop.build.extraResources.find(item => item.from === '../agent-runtime').filter;
  for (const module of modules) {
    assert.ok(archive.includes(`src: agent-runtime/${module}`), `archive is missing ${module}`);
    assert.ok(docker.includes(`- agent-runtime/${module}`), `release Docker is missing ${module}`);
    assert.ok(filter.includes('*.mjs') || filter.includes(module), `desktop is missing ${module}`);
  }
  assert.match(readFileSync(new URL('Dockerfile', root), 'utf8'), /COPY agent-runtime\/\*\.mjs \./);
  const webBuild = readFileSync(new URL('Dockerfile', root), 'utf8').split('FROM web-deps AS web-build')[1].split('AS go-build')[0];
  assert.match(webBuild, /COPY agent-runtime\/context-policy\.mjs \/app\/agent-runtime\/context-policy\.mjs/);
});
