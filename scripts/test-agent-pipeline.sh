#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf '%s\n' '[1/4] LangGraph: execution, migration, cache prefix and failure recovery'
npm ci --ignore-scripts --prefix agent-runtime
npm test --prefix agent-runtime

printf '%s\n' '[2/4] Frontend: run lifecycle, approvals, recovery and AI Elements'
bun install --cwd web --frozen-lockfile --ignore-scripts
npm run lint --prefix web
npm test --prefix web
npm run build --prefix web

printf '%s\n' '[3/4] Go: tools, domain acceptance, persistence and model usage'
go test ./... -count=1 -timeout=10m

printf '%s\n' '[4/4] CI event rules'
node --test scripts/__tests__/ci-trigger.test.mjs
