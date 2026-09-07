请接着独立处理工作流残余问题，主代理正在图片工作台和静态资源；不修改总 inventory / REVIEW.md。
1. 完整读当前 creative-workflow-workspace.tsx / workflow-task-runtime.ts / workflow-runtime.ts，核实跨标签账号切换后 runAllSeriesDrafts 多 chunk、reference upload 和普通生成能否继续用新账号提交旧提示词。已知 auth 事件只中止 Agent 草稿、taskWaitAbortControllerRef 仅 unmount abort；AppShell/AnimatedRoutes 无 session key remount。R33 已保护 runner 草稿异步 UI，保留它。
2. restoreWorkflowTasks 的 batch_count 大于已持久化任务数（部分提交失败）是否永久 running。既有单测强调未全部持久化时不提前成功，不能草率改成成功，需实际验证合理结束方式。
发现实证问题就修复并做行为回归（修复前失败、后通过）。可用 build/review/workflow-draft-race.mjs 模板与现有 Vite port18642，但不要停/改共享服务。使用模拟 API，不要真实上游。
交付 review/workflow-followup-results.json，逐文件 SHA256 / checks / 修复说明和测试日志，勿给问题编号。相关 workflow 已 reviewed，若修改必须复核当前内容。范围之外不改，告知主代理。
