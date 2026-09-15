# 审查产物说明

最新完整逐文件审查见 [2026-09-14-complete.md](2026-09-14-complete.md)，最终覆盖证据为 [current-inventory.json](current-inventory.json)。当前清单包含源码、测试、配置、文档、原始素材及单独列示的审查元数据和排除项，可用 `python3 review/validate-current-inventory.py` 检查最终哈希与文件覆盖。`current-*.json` 是本次分组阅读记录；同一文件的后续修改以最终清单匹配的证据为准。

最新效率与正确性修复见 [2026-09-14-efficiency.md](2026-09-14-efficiency.md)，先前续审见 [2026-09-14-followup.md](2026-09-14-followup.md)，同日先前记录见 [2026-09-14.md](2026-09-14.md)。2026-09-07 的覆盖范围和验证结论保留在根目录 `REVIEW.md`；`inventory.json` 是该轮结束时包含 594 个项目文件的历史快照。本轮没有刷新旧哈希或把历史记录重新标记为已审查。

`validate-inventory.py` 可检查工作区与历史清单的内容哈希、字节数、适用行数和 Git 文件覆盖差异；后续版本发生修改后不应预期该快照校验通过。

```sh
python3 review/validate-inventory.py
```

其他 `*-results.json` 和早期分组 JSON 是各审查批次的快照，不保证其中旧 SHA256 对应后续修改。2026-09-07 的最终合并以 `inventory.json` 为准；`final-followup-results.json` 记录该轮主代理最后的差异复核。`*-scope.json` / `*-scope.md` 是任务划分记录，不能作为完成证据。

2026-09-07 的源码记录完整阅读和调用关系检查；图片/模型记录解码、结构与可视检查。静态导演台 JS 包完整解析并审阅业务部分，没有逐行审计全部第三方依赖。各轮的覆盖范围和验证限制以对应日期的报告为准。

日志、浏览器复现脚本和截图保存在被忽略的 `build/review/`。这些文件是本地验证证据，不应作为真实上游调用成功的证明；审查文件本身与原有备份单独列示，不计入 594 个项目源文件。
