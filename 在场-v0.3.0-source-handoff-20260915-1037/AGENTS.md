# 在场 · 开发入口

- 接手或定位未知变更时用 [project-navigation](.agents/skills/project-navigation/SKILL.md)；[PROJECT-NAVIGATION.md](PROJECT-NAVIGATION.md) 是唯一职责、现状和文件索引。
- 重大产品取舍或全面重设计按需用 [project-foundations](.agents/skills/project-foundations/SKILL.md)；体验设计与评审按需用 [product-design](.agents/skills/product-design/SKILL.md)。局部小修不必加载全部背景。
- 区分原则、当前策略、方法与实现；未知模块保留缺口。目录、职责或状态变化同次更新导航。Skills 是开发指导，不是运行时数据、权限或强制安全机制；实际操作范围由当次用户任务决定。

## 本次临时代测（用户在 2026-09-13 明确授权）

- 用户指定通过 App Server 使用 **GPT‑5.6‑Luna** 暂代 DeepSeek；Luna 只是代替的测验品。具体契约、命令、证据与差异见 [LUNA-TEST-SUBSTITUTE.md](LUNA-TEST-SUBSTITUTE.md)。这一例外不修改下方 DeepSeek 生产默认。
- 保留原 Harness、上下文、权限、图文、记忆与行动链，只替换模型传输；不启动 Codex 开发子代理。每份代测报告写明真实提供方/模型/临时代测身份，不冒称 DeepSeek 验证通过，不套用其价格。
- 后端测试总门槛完成前仍禁止使用 product-design 与 product-design-director。

## 项目 DeepSeek 凭据

- 用户已明确授权本项目及其后续 agent 在任务需要时调用已保存的 DeepSeek API Key；不要再向用户索要或要求粘贴 Key。这不自动授权与当次任务无关的批量消耗或外部写入。
- 凭据在仓库外由 Windows DPAPI 按当前用户加密。先运行 `npm run deepseek:check`；成功后用 `npm run deepseek:run -- <command> [args...]` 在单个子进程中临时注入，开发桌面程序用 `npm run dev:deepseek`，真实评估用 `npm run eval:harness:live:project`（仅该专用入口开启 live 评估门禁）。
- 不得打印、回显、写入日志/报告/代码/配置、提交到 Git，或将 Key 传给无关连接器/不受信命令。包装器退出后临时环境变量即被清理。
- 当前官网多模态路由固定为 `deepseek-flash`；存量设置、renderer 或评估环境变量不得覆盖。图文直接作为同一条 user message 发送，不预先转写、不生成向量、不把图片内容进入长期记忆提取。
- 图片只从原有“＋”上传菜单进入，不新增相机或第二入口。发送前保留长条草稿预览；发送后显示独立紧凑缩略图，只有用户手动点击才打开大图预览。

### 当前官网调用契约（2026-09-13 核对）

- 提供方是 DeepSeek 官方 API，端点是 `https://api.deepseek.com/chat/completions`，请求体的唯一模型 ID 是 `deepseek-flash`。官方当前将它定义为 **DeepSeek-V4.1-Flash**，具备原生文字+图像理解。官方依据：<https://deepseek.com/news/deepseek-v4-1-flash/>。
- 不得改用 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4-pro`、`deepseek-chat` 或 `deepseek-reasoner`。前两者是已退役 V4 的兼容名，会路由到 V4.1；其他名称也不是本项目契约。不从服务端简写、历史报告或 UI 文案反推模型。
- 纯文字与图文对话使用同一模型。图文请求是一条 `role: user` 消息，`content` 同时含 `{type: "text"}` 和 `{type: "image_url"}`；图片以 `data:image/jpeg;base64,...` 传入。模型能直接把视觉位置用于文字规则和日常回复，不是只做图像描述。
- 应用边界：原图最大 8 MB，宿主最长边缩至 1600px、移除 EXIF、统一转 JPEG，data URL 上限 3,000,000 字符。图片仅在当前图文消息中送入模型，不放进文字记忆提取。
- 可复现检查：`npm run test:deepseek:vision` 直连官网验证联合理解；`npm run test:multimodal` 验证 Electron 合成契约；`npm run test:multimodal:live` 验证真实 Electron→IPC→Harness→DeepSeek 全链。当前真实报告为 `artifacts/review/multimodal/live-report.json`，必须同时看到 `model=deepseek-flash`、`textParts=1`、`imageParts=1`才能声称图文接入成功。
- 官方若以后改变模型映射，后续 agent 必须先核对最新官方公告并重跑上述两道真实验证，再同次更新代码常量、AGENTS、DESIGN 和 PROJECT-NAVIGATION；不得静默跟随新别名。

## 永久前台设计约束

- 在场面向正在处理生活与校园事务的人，不面向工程师审查 Harness。默认用户不认识 `scope`、`epoch`、`receipt`、`candidate`、`provider`、`coverage`、`obligation`、`source ID` 等词；这些只能留在后台或按需展开的说明中。
- 每个页面先回答一个问题：用户现在最需要知道什么？默认只保留一个视觉焦点、一个主要动作和一个清楚退路。不要把四个同权重状态、标签、卡片或解释并排放在同一视线带上。
- 记忆页首屏只回答“哪些内容现在会帮到我”。当前有效内容直接显示；待确认、停用、待整理统一进入一个次级入口，展开后再给详情。不要把“正在使用／待确认／有原文依据／尚未核验”等生命周期词做成首屏导航。
- 前台文案先说结果和下一步，再说依据；状态用自然句表达。建议、已登记、已执行、未知、需去原服务确认必须分开，但不同时展示内部状态矩阵。
- “简洁”不是隐藏必要控制：来源、权限、撤销、失败和未知必须可发现，但采用渐进披露。来源/核验放在详情，错误/撤销放在触发点旁，不能靠颜色或小字传达唯一含义。
- Apple 风格只借鉴因果一致、直接操作、连续反馈、安静而可打断的动效、渐进披露和熟悉控件；不复制皮肤、圆角、字体或营销腔。减少动态效果、键盘、焦点、窄窗和长内容必须实际检查。
- 以低技术熟练度用户作为压力测试：不读 README 也应能开始、理解、改正、撤销和退出。若设计需要用户先学习产品原理，优先删概念而不是加解释。
- 任何前端修改都要在真实 Electron 运行、截图并用图像工具查看后再声称完成；更新 [DESIGN.md](DESIGN.md)、[PROJECT-NAVIGATION.md](PROJECT-NAVIGATION.md) 的证据和限制。

## Subagent model routing

- Default model for the primary agent and every ordinary subagent is `gpt-5.6-sol` with `xhigh` reasoning.
- Use `gpt-5.6-luna` (including `fast_luna`) only when the current user explicitly requests Luna or fast_luna.
- Use any other non-Sol model only when the current user explicitly names that model.
- Do not infer a request for Luna/Terra from task size, speed, cost, read-only scope, or convenience.
- If a delegated request does not contain explicit user authorization for a non-Sol model, route it to the Sol XHigh lane instead.
- A subagent must not refuse, stop, or return an empty result merely because model authorization is unclear; routing is the parent agent's responsibility.
