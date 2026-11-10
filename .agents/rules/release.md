# 提交与发布

路径相对于仓库根目录；修改工作流、准备提交、PR 或发布前读取。

## 提交与 PR

Recent history uses Conventional Commit-style subjects such as `feat: ...`, `chore: ...`, `feat(httpapi): ...`, and breaking markers like `feat!:`. Keep subjects concise and scoped to intent. Pull requests should include a summary, verification (`go test ./...`, `npm run build`, screenshots for UI changes), linked issues when applicable, and notes for config or deployment changes.

## 版本与发布工作流

- 按语义化版本选择版本号：不兼容的 API、数据或配置变更升主版本；兼容的新功能或显著功能升级升次版本并重置补丁号；仅修复问题、无新增功能时升补丁版本。不得将功能版本一律作为补丁版本发布。
- CI runs only for pull request `opened`, `synchronize`, and `closed` events; both jobs skip closed PRs that were not merged. Merging a PR runs CI against the event commit. Ordinary branch pushes, including direct pushes to `main` and `dev`, do not trigger CI. Pushing updates to an existing PR still triggers CI.
- All CI jobs check out the event commit (`github.sha`) so queued checks do not follow later branch changes. Validate workflow changes with `node --test scripts/__tests__/ci-trigger.test.mjs`.
- Frontend lint and tests, Agent runtime and desktop tests, backend tests and vet, race tests, and database integration checks run in PR CI. Version tag and manual release workflows build, package, and publish without rerunning these checks or waiting for CI. Windows desktop packaging also builds without rerunning tests. Release tag, release notes, credentials, and artifact checksum handling remain part of packaging and publication.

Every release commit must include a root `RELEASE_NOTES.md`. Its first line must be `# vX.Y.Z`, matching the release tag. It must contain exactly these five H2 sections in order: `版本概览`, `新增功能`, `功能改进`, `问题修复`, and `移除与调整`. Every section must contain content; use `- 无` when no change applies. Do not add other Markdown headings. Validate locally with `bash scripts/validate-release-notes.sh`, or pass the expected tag as its only argument before release.
