# GPT‑5.6‑Luna 临时代测说明

2026-09-13 用户明确要求：DeepSeek 余额不可用时，现在通过 App Server 使用 GPT‑5.6‑Luna，作为代替的测验品。名称统一为 **DeepSeek**。生产默认契约仍为 `deepseek-flash`，Luna 结果不能作为 DeepSeek 的运行证据。

## 已接入的边界

启动环境 `ZAICHANG_MODEL_TRANSPORT=luna-app-server-test` 仅由宿主入口选择，存量设置和 renderer 不能开启它。`createModelClient` 在原调用位置替换模型适配器；控制判断、Hermes 主循环、原生只读委派、工具授权、SQLite、上下文编译与范围切换、记忆提取/核验、动作事务/回执、独立成稿/核验均继续调用原实现。没有创建 Codex 开发子代理。

App Server 提供已登录账户的认证。每次 `complete()` 使用一个临时传输会话；环回地址带一次性随机路由，只接受一条请求。适配器将 Codex 自动生成的提示和工具定义替换为宿主的完整消息与本轮工具 schema，再转发到固定的官方模型端点。模型的函数调用直接返回 Hermes，App Server 只收到传输结束通知，不执行模型工具、不接管任务调度。禁用其内置执行工具及继承的 MCP 服务。DeepSeek Key 不进入该进程；账户 token 只在内存中转发至固定官方端点，不写配置、日志、报告或源码。

图像作为同条 user 消息中的原生 `input_image` 发送；文字原样保留为 `input_text`。Electron 原有 8 MB/1600 px/JPEG/去 EXIF 处理与“＋”入口不变，不预转写、不生成向量、不进入文字记忆提取。协议角色由 Chat Completions 转为 Responses；加密推理续接项只留在宿主已有的有限内存协议链里，范围/隐私版本切换仍由原 Harness 清除链条。

## 已知差异，不宣称性能完全相同

- Luna 为 `gpt-5.6-luna`，开启思考时固定 `xhigh`；显式关闭思考仍映射到 `none`。两种模型的推理内容和语义表现不保证相同。
- 实测 App Server 账户端点拒绝 `max_output_tokens`（HTTP 400）。宿主仍拒收超出原输出 token 上限的结果，但无法在服务端提前限定这次生成的 token 消耗。报告将其标为 `outputEnforcement=host_post_completion`，不伪称完全等价。
- 账户额度与 API 计费不同。Luna usage 带提供方和模型标识；人民币/美元成本保持未知，禁止套用 DeepSeek 价格，也不能把未知记为零。代测批次仍限制调用次数、输入字节和累计输出 token。
- 协议适配并不代表每项能力已完成真实验收。最终以逐阶段回执、实际观察和保留的失败报告为准；生产 DeepSeek 图文复测仍需要其余额恢复。

## 当前证据与使用

`npm run test:luna:transport`：五项机制检查通过，覆盖原文/图像/工具映射、实际工具结果续接、未授权工具与错模型拒绝、取消/边界失效、默认路由隔离。`npm run test:luna:live`：三次真实请求通过，覆盖原生工具调用、随机代码的真实工具结果续接、图像位置与文字规则联合理解。记录在 `artifacts/understanding-action/luna-transport-live/report.json`。

通过 `npm run eval:harness:luna:test -- --understanding-stories` 运行相同故事与原 Harness；`npm run test:multimodal:luna` 运行真实 Electron 图文全链；`npm run dev:luna:test` / `npm run start:luna:test` 用临时代测模型启动。选择批次时继续使用原 `ZAICHANG_STORY_SET`、`ZAICHANG_STORY_FILTER`、`ZAICHANG_STORY_REPEATS`，报告输出目录须与 DeepSeek 分开。

当前仍在后端阶段，两个前端设计技能尚未启用。Electron 链路检查不等于前端设计完成。

补充真实证据：原 Harness 的 S01 校园查询、S21 混合任务均通过，共25次模型调用；`artifacts/understanding-action/luna-first-harness/report.json`。真实 Electron 图文全链在 `artifacts/understanding-action/luna-electron-multimodal/live-report.json`，实测 `model=gpt-5.6-luna`、`textParts=1`、`imageParts=1`、实际 JPEG。已查看发送后截图，图像与文字位置规则联合产生拿钥匙提醒。**旧界面模型标签仍写 DeepSeek**，在后端总门槛后的前端阶段处理；不得用这份截图宣称前台已正确标注或设计已完成。

官方参考：[App Server](https://learn.chatgpt.com/docs/app-server)、[Luna 模型](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。本机验证 CLI 为 `0.154.0-alpha.6.2`；实际 wire schema 和只含合成输入的探针位于 `artifacts/understanding-action/luna-protocol/`。
