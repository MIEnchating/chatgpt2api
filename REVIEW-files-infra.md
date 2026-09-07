# 基础设施与研究资料逐文件审查

审查日期：2026-09-07。范围为根目录 tracked 文件、`.github/`、`scripts/`、`docs/`、`jshook/`：39 个原 tracked 文件，加 2 个本次新增脚本，共 41 项。除明确说明的锁文件/二进制外，均实际完整读取；表中 SHA-256 对应修复后的当前内容。没有读取真实 `.env`、调用真实上游、修改部署或发布。本文不将历史研究文档认定为今天有效的协议证明。

本轮确认并处理研究脚本凭据/捕获/下载边界，以及当前与历史文档的明确矛盾。验证：6 项离线 Python 测试、四脚本 AST/py_compile、release notes Bash 语法及 v3.0.6 合同、五 JSON 解析、PNG CRC、go.sum 结构、go mod verify、git diff --check。跨账户上游联调、GitHub Actions、GoReleaser 发布、Docker 多架构构建未在本分工重新执行。

| 路径 | 内容 SHA-256 | 已读检查要点 | 发现 / 验证边界 |
| --- | --- | --- | --- |
| `.env.example` | `a450a298c314b9efee4bc91479e246ec0c5c4e5a84a3a3504cebb42a3396e9f5` | 完整读取 157 行；核对管理员、上游/业务库区分、模型、容量、Cron、Docker 参数与配置入口 | 仅示例值；没有读取真实 .env；外部连接可达性未验证 |
| `.gitattributes` | `d59488df661126b6e07efd98c43772b1adaa582d886266ede4028a30af7e2551` | 完整读取；检查 shell/Docker/YAML LF 规则 | 无确定问题 |
| `.github/workflows/ci.yml` | `b2abd3167af5e9dcc7fc5dbd1d0c6097abca0c2e3ad2c64f26c2ac5e023f9401` | 完整读取；检查权限、并发、前后端测试顺序、嵌入产物、数据库 service 与 DSN | 与当前目录一致；未触发 GitHub Actions |
| `.github/workflows/release.yml` | `ccb9feb133fbbbf0a48f2badc94bf1563f4d17b70adacefbc62032ad748d6292` | 完整读取；检查标签稳定版本正则、commit 一致性、release notes、secret 使用与构建发布先后 | 只做静态审查；未登录 Docker Hub 或发布 |
| `.gitignore` | `6dc2dfa31c1d9e48a6bebd77d947ab5dabf3637af19ddbd653ecb5ea566f4216` | 完整读取；检查构建、环境文件、数据库和抓包隔离规则 | 已增加 jshook/responses/local/；git check-ignore 验证通过 |
| `.goreleaser.yaml` | `1cf7d08bf304523aaa6e3b89e3dfec29550ae3349904e5cb8ae4d22f24808f09` | 完整读取；检查目标架构、embed flag、archives、Dockerfile 路径、镜像标签与 release metadata | 未运行 GoReleaser 发布；许可证分发合规未作法律判断 |
| `AGENTS.md` | `2e6f234ac5f886b0f94d0a7c30115266dc5b594fafd257dd40061656773698b6` | 完整读取；对照语言、分层、协议证据、测试与 release notes 约束 | 本次按所属范围执行；没有修改规则 |
| `CHANGELOG.md` | `63cdf2e611ddeeffacbd794fda3dcf9b5b3831d8a06c8810d34472934ae4e541` | 完整读取 444 行；区分历史功能和当前能力、检查迁移说明 | 存在重复 0.1.7 历史标题，未删改历史事实；不将旧版本描述视为当前合同 |
| `Dockerfile` | `9b7f08cbbd7df7253855c6559f5a4964d0bf07bcb8bad7980a9a58526ff34de0` | 完整读取；检查 Bun/Go 锁定版本、分阶段复制、cross compile、runtime 依赖与健康检查 | 路径与构建输出一致；未重新构建多架构镜像 |
| `Dockerfile.dockerignore` | `b9ad8ed3186b3a107b0847d873ee49b69cc36b4bed56617505100f4dfc82d56c` | 完整读取；检查凭据、数据库、构建缓存和研究样本不进入主镜像上下文 | 包含文件仍可由 Docker COPY；未触碰用户未跟踪二进制 |
| `Dockerfile.release` | `00960053277078327afb274d606bbb3162987b5be071b44f731ad46ca5a7dafd` | 完整读取；检查 TARGETPLATFORM 二进制复制、runtime 包和 PORT 健康检查 | 依赖 GoReleaser staging 结构；未进行实际发布镜像构建 |
| `LICENSE` | `b21dd4c2da43718348760993f0fc138af271718dd7eb954efe54506443ccadce` | 完整读取 MIT 授权与版权声明 | README 另含使用声明；法律效力与合规不属于本次技术验证 |
| `README.md` | `73930fc880ed78f0453285f7ea42badc3c35a4419d2da2f15b13f19f669c9a9a` | 完整读取 495 行；对照登录、存储、开发、CI、release、研究索引与实现 | 修正本地密码用户缺失和 dev CI 分支遗漏；部署命令未作用于真实服务 |
| `RELEASE_NOTES.md` | `e9184cd945bbb4c921193e1ae0fdcfd5807a40f41acfb0b950996c25c7de6e36` | 完整读取；检查 v3.0.6 与五节标题及非空内容 | bash scripts/validate-release-notes.sh v3.0.6 通过；未生成新版本或标签 |
| `docker-compose.yml` | `c0047e545cf43755243a40406fb1d4b4a8aa230e889ca17dc43e1af381102563` | 完整读取；检查 env_file、挂载、外部网络、固定容器名与 README 一致 | 没有对公网映射端口；未使用真实 .env 或修改部署 |
| `docs/architecture.md` | `439ea3ef05a40da72a3f77304d06796e5677eb8a3c2fd4ac3195a1c3b578eca0` | 完整读取；与 internal/architecture_test.go 的禁止依赖方向对照 | 描述与当前边界一致；其他文件语义由各负责代理审查 |
| `docs/image-generation-api.md` | `fa07122b3de2e2ce5b0d5629f4f83603a5d0088d86bd2a93af3a84b70a501ae6` | 完整读取 464 行；检查 Cookie、creation-tasks、任务状态、媒体存储和迁移叙述 | 修复错误 IndexedDB fallback/自动迁移承诺；模型厂商实时行为未联调 |
| `docs/video-generation-api.md` | `77a790abea616af368c9d5d49225383b8f1b713d8f2b75eed1bdf9df97c614aa` | 完整读取；对照契约匹配、请求快照、driver、artifact auth 与格式版本 | 导入导出协议 v4 正确（与存储文档 v8 不同），无需改版本；未调用视频上游 |
| `go.mod` | `18ee0432b8be8680f260ea4e31fba9e8f3ce86d00bb4740ce09e5bab7e3d08fe` | 完整读取 55 行；核对 Go 1.26.6、直接/间接依赖与 Docker/Actions 版本 | go mod verify 通过；不代表依赖无漏洞 |
| `go.sum` | `c589decc05aa183522035f3611d596e9f10f27c036f9abf78cd2c9ab9d1ed6ea` | 结构完整性审查全部 151 条：三列、h1、base64 32 字节、无重复；不是逐行依赖语义阅读 | go mod verify：all modules verified |
| `jshook/README.md` | `baaff6c7990ed1d3b34a8d5f9890fe4d6c93dce360556cf5e540234376c5e778` | 完整读取；核对索引路径、早期脚本与后续 HAR 差异、产物与脱敏边界 | 补历史状态说明与凭据环境变量/私有输出规则；没有重新验证上游 |
| `jshook/docs/ChatGPT-gpt-image-2-generation-pipeline-analysis.md` | `23144b43a16fa1b03e6391cca6d7180d39af88e828785b3e7c5539f25c6bc386` | 完整读取 746 行；核对 HAR/脚本观测来源、旧实现路径、尺寸与示例自洽 | 修复 1254 输出却声称所有输出为 16 倍数的矛盾；明确旧实现已移除 |
| `jshook/docs/api-endpoints.md` | `0ebb70a91ad57d3879f33ddb1bc83c291c81c668b3f321c1f2f0664258819c5b` | 完整读取 229 行；核对端点、认证字段和 JSON 示例；区分验证/推测标签 | 仅历史 2026-05-07 证据，不证明今天端点或协议有效 |
| `jshook/docs/authenticated-api-schema.md` | `c886000376b9cfcc39afd0064df37fb7764bfa38eed6e44f2b7ad39c4f200d08` | 完整读取 396 行；核对单步 Sentinel、headers、prepare/generate 和 SSE | 补单步实验与 HAR 分离、Arkose 不等于 Turnstile；不更新实际上游协议 |
| `jshook/docs/content-type-enum.md` | `d4fc1dab32b4371d11cc394e4441b22ee980bc5db857fa6d436d0df6e7792ac8` | 完整读取 106 行；区分 renderer zo、API content_type、SSE type 与 recipient | 混淆名/推测项仅历史资料；未从当前 bundle 重新还原 |
| `jshook/docs/function-mapping.md` | `1738aac62a7e87d087b589e8893098dd9bff18d1d4e61deda122aba66ac6bc92` | 完整读取 85 行；检查调用链、上传、渲染、路由、埋点映射类别 | 全部依赖历史 minified bundle，未证实当前名称 |
| `jshook/docs/internal-codenames.md` | `6ad922541d2fa88faecd48da2c34f904c7dadd2e41ac70cc018e58d5de063584` | 完整读取 76 行；检查模型/工具、channel、资产协议和缓存键区分 | 推测条目保留推测标签；未调用当前上游 |
| `jshook/docs/request-completion-flow.md` | `49b2abf48599e092e9769ae44511b7c86373fcc642c964e2c16b94bbb418517a` | 完整读取 287 行；检查 composer/OV/mp、patch 结构、编码标记、结束事件 | 调用链为历史观察；本轮未改请求构造或 PoW |
| `jshook/docs/upstream-sse-conversation.md` | `40d2f4435d925db562b74ab2d3f369a4e1fd58f397c0754fde2a4b09c5abfdc0` | 完整读取 271 行；与已提交生图 SSE fixture 对照输出判定 | 修正强制 async_task_type 会丢掉当前样本的问题；支持基于抓包确认的工具标识 |
| `jshook/responses/conversation-init.json` | `885512b565165bd55d48c21e7a2ff91cffaf4112a64fb84d359637fe4d1a4647` | 完整读取；JSON 解析并检查匿名限额/模型字段 | 未见 token、账户身份或签名下载 URL；限額时间仅历史样本 |
| `jshook/responses/file_00000000bc987209adba1c148413e076.png` | `41c83b6940e673e8104e2174cbdf8d3ab57ee4839b2d1cf34f540040038b431d` | 二进制例外：完整读取校验 PNG chunk CRC，查看图像与 caBX 可读元数据 | 图像为庭院；含 C2PA 公共证书/来源信息，未发现用户凭据；未验证 C2PA 信任链 |
| `jshook/responses/image-gen-sse-response.json` | `4ef0d8a8b74f1592665ae5f2b92f85ac1d76280a393d1a6edb74e86b7aef8800` | 完整读取 316 行；检查 patch/工具输出、token/cid 脱敏与元数据 | JSON 有效；token/cid 已脱敏；保留消息/生成 ID 等非认证关联标识 |
| `jshook/responses/images-styles.json` | `58eaca59e89849240d6b9f75ca45342fc8a98a2002967bfd395fd6e02b1da7a3` | 完整读取全部 32 项（格式化后检查）；核对预设结构和静态资源 URL | JSON 有效；URL 为无签名公共预设资源，不含认证下载凭据 |
| `jshook/responses/refreshed-tokens.json` | `ec1d25bb24e0a56c15b7877cff2605412179849907b161fc2b05da75a81fb653` | 完整读取；核对 OAuth access/id/refresh token 均为 REDACTED | JSON 有效；未调用刷新接口 |
| `jshook/responses/text-chat-sse-response.json` | `f84dcbde6e217739e8443a4a5c382e9efea6343e0f902bf7ab68e4f21d79a189` | 完整读取 371 行；检查直接 message、done、token/cid 脱敏 | JSON 有效；固定 Hello/Hi 测试文本；未见账户凭据 |
| `jshook/scripts/image_gen_full_flow.py` | `c588f0845c7f1d27f4ed7f4744fe5a0d9d4676a5f8e7f5e9141c27dffbb82601` | 完整读取 771 行并复核本次 diff；检查凭据、原始输出、下载鉴权、状态与 SSE 结束 | 修复 token 硬编码入口、tracked fixture 覆盖、敏感输出、跨域 Session 泄漏和把非图片失败下载当成功；未运行真实生成 |
| `jshook/scripts/verify_text_chat.py` | `bfb689b37161407a6b9d5dd8bc69adf89b9c96dbebb57257f02d2e3aadd0e08f` | 完整读取 246 行并复核本次 diff；检查配置导入、三条测试请求和响应保存 | 改环境变量 token、独立私有捕获目录，取消原始错误正文输出并关闭失败响应；未执行真实文本请求 |
| `scripts/validate-release-notes.sh` | `8223ac2ae948f4382f35b32170d5040048bc420990d7703feb3fda300f1ac28f` | 完整读取 82 行；检查 set -euo、大小、标签正则、标题顺序与空章节 | bash -n 与 v3.0.6 验证通过；未修改已有 release notes |
| `staticcheck.conf` | `c26212d636e05cfa31b7908e5eea0cfbdfc03267e648763fd8eb8793d3007d5a` | 完整读取；检查只禁用 ST1005 错误消息英文风格检查 | 保留 inherit 其他检查，没有增加忽略项 |
| `jshook/scripts/capture_safety.py` | `702e7f37b5c312ff38d8f6d711a6deb3b5e9dcee95b5d1c73f9d13b045215eeb` | 新增文件完整复核；检查 env-only token、0700/0600、独占创建、同源鉴权和无凭据公网下载 | 6 项离线测试覆盖核心边界；禁止重定向；不做当前上游可用性承诺 |
| `jshook/scripts/test_capture_safety.py` | `1735b5d069c7a8b6447e12b6c7637455a9ff40c54fd39966d9f00200e76a6231` | 新增文件完整复核；六项 unittest 使用 fake transport，无外部依赖或网络 | 6 tests PASS；验证权限、防覆盖、origin/port/redirect/MIME/auth 边界 |
