# 审查产物说明

最终覆盖范围和验证结论见根目录 `REVIEW.md`。`inventory.json` 是最终当前文件清单，包含 594 个项目文件；`validate-inventory.py` 检查每个当前文件的内容哈希、字节数、适用行数和 Git 文件覆盖。

```sh
python3 review/validate-inventory.py
```

其他 `*-results.json` 和早期分组 JSON 是各审查批次的快照，不保证其中旧 SHA256 对应后续修改。最终合并以 `inventory.json` 为准；`final-followup-results.json` 记录主代理最后的差异复核。`*-scope.json` / `*-scope.md` 是任务划分记录，不能作为完成证据。

源码记录完整阅读和调用关系检查；图片/模型记录解码、结构与可视检查。静态导演台 JS 包完整解析并审阅业务部分，没有逐行审计全部第三方依赖。外部上游及真实 S3/WebDAV 未联调；完整限制见根报告。

日志、浏览器复现脚本和截图保存在被忽略的 `build/review/`。这些文件是本地验证证据，不应作为真实上游调用成功的证明；审查文件本身与原有备份单独列示，不计入 594 个项目源文件。
