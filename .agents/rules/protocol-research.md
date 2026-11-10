# ChatGPT 协议研究

路径相对于仓库根目录；修改上游协议或开展 jshook 研究前读取。

Use `jshook/README.md` as the index for ChatGPT web protocol research. Keep endpoint inventories, content-type mappings, request-flow notes, internal codename mappings, and authenticated API schema notes in `jshook/docs/*.md` rather than duplicating them elsewhere.

Use jshook MCP (Chrome CDP + JS Hook + Network Interception) when fresh browser evidence is needed for ChatGPT web behavior, especially request construction, SSE event shape, frontend function mapping, Statsig gates, PoW/sentinel requirements, and image-generation flows. Treat upstream ChatGPT behavior as time-sensitive: verify with a fresh capture or script run before changing backend protocol code based on these notes.

Keep validation scripts in `jshook/scripts/` and raw or reduced response artifacts in `jshook/responses/`. Do not commit live OAuth tokens, cookies, account identifiers, proxy credentials, private prompts, or reusable CDN/download URLs; redact or regenerate fixtures before saving them. jshook scripts may require authenticated local state and external network access, so they are not part of the default `go test ./...` or frontend build verification unless a task explicitly targets those flows.
