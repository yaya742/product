# Harness 0.3 · 实施与恢复说明

当前职责与能力状态以 [PROJECT-NAVIGATION](PROJECT-NAVIGATION.md) 为准。当前任务依据是[理解与行动完整实施提示词](在场-Harness-理解与行动-设计实施包/在场-Harness-理解与行动架构包/02-Codex-完整实施提示词.md)及同包00–04。任务未完成，进度见[实施记录](UNDERSTANDING-ACTION-IMPLEMENTATION.md)和[当前实测报告](artifacts/understanding-action/CURRENT-REPORT.md)。本文后面的旧轮次证据保留历史身份，不自动证明本次源码通过。

源码入口沿用 Electron、React、SQLite 与既有业务服务。固定 Hermes `d595e636c83aa0b9606d4e914e1140ae9c796897` 的 AIAgent 是唯一生产模型工具循环，委派也用其原生实现；TypeScript 负责权限、数据、预算、工具、回执、事件和私有 stdio 传输。


## 入口与写入

临时代测入口及限制见 [LUNA-TEST-SUBSTITUTE.md](LUNA-TEST-SUBSTITUTE.md)。用户指定的GPT‑5.6‑Luna通过App Server账户认证接在原宿主模型出口；不是另起一个生产决策循环。DeepSeek生产默认不变。主调用、原生工作者、记忆、压缩、核验和成稿使用同一选择；提供方和模型随回执明确记录，未知账户费用不套用DeepSeek价格。

原 Electron 输入框经受信 IPC 进入 `Harness.start`。先执行本机禁传与凭据检查，再用窄模型提案收缩资料/保存/受众范围，之后才保存获准正文。主模型得到原话，不由宿主词表生成参与方式、最终意图或行动批准；旧 RequestFragment 分类不再承担这项职责。未发送草稿先留在内存，显式确认后才持久化。`transmission=local_only` 在任何云端控制解析之前阻断外发，尚无离线模型时诚实返回不可处理。

主调用、独立工作者、记忆整理、压缩与检查均经过宿主模型出口。同一合法范围的文字协议链只驻留内存，来源收缩/遗忘/撤权清除；图片只进入当前图文轮，不在后续纯文字轮重放，也不进入长期记忆提取。工作者声明来源与本轮证据 ID，不能超出父范围；读取用途以根用户原话核验，助手生成的工作者指令不构成授权。

宿主生成 principal/workspace/device；`ScopeHandle` 由 WeakMap 校验，不接受模型传入身份。Repository 在 SQL 读取正文前约束主体、世界、来源、用途、受众、期限和版本；检索、原文读取、关系展开、缓存及 Provider 沿用同一范围。这里是单用户桌面宿主的逻辑隔离，不是多租户登录平台或 OS 沙箱。

候选提取和独立语义复核使用现有 DeepSeek 接口。正式理解只有 `MemoryService.commitVerified` 一条提交路径，UI 改正也走这条路径。保留条件 AST、否定、单位、时间、来源定位、核验状态和版本；不明确的候选保持待确认。中文字符索引与原文通道独立于理解提取，未处理的长消息尾部不会被“摘要已完成”掩盖。模型侧对递归 work-change schema 使用有界兼容方言，工具执行仍由本地 Zod 契约裁决。

`ContextCompiler` 先提供小型当前情境、已授权能力目录与必要原话；事项恢复/候选预取/方案依赖补查按需进入。原文未提取或索引未就绪时仍有权限先行的原文检索通道。完整条件与来源超预算时明确部分覆盖，不截掉条件后宣称完整。`ContextReceipt` 记录实际来源、对象版本、查询、运行引擎、预算与机制使用次数，未将隐藏思维链写入持久化或公开解释。

Episode、Goal、Plan、Commitment、Task 与假设 World 分开保存。World 绑定不可变现实版本与假设，采用前逐项比较；目标、资源、来源或理解改变使有关依赖失效。拒绝理由保留适用条件，资源检查有期限，新的已授权能力可使旧理由失效。UI 的目标采用、暂停、取消及反馈接入相同持久路径，接受建议不记为真实成功。

## 动作、提醒与 Provider

默认 `prepare_action` 仍先准备本地安排；但对本人现实范围内、参数充分且可撤销的明确本地登记，可信宿主可走 `direct_local`，直接完成并给可撤销回执。Approval 绑定动作参数摘要、版本、受众、期限、策略版本和隐私 epoch；所有执行路径仍在派发前复核。Action → Approval → Attempt → Receipt 的状态持久化，重复确认不产生第二次执行。外部超时可能已生效，保留 unknown，重启后先核查；不支持核查的提供方返回 unresolved，界面引导到原服务确认，不换键重试。

本地安排与回执同事务提交。提醒包含持久 lease、fence、dedup、安静时段、每日预算、冷却、目标取消及休眠恢复；默认安静时段为 22:00–08:00，每日最多 3 次，间隔至少 10 分钟，可通过可信宿主配置。应用关闭不保证提醒；当前 OS 端只报告“提交系统”，不报告送达或已读。单个安排完成只影响本地记录，不能增加校方体育计次。

Broker 为校园分域、地图、杭州天气、本地安排和证据读取提供 schema、授权、来源、状态、取消、超时、去重与受限网络入口。原地图组件和源路网保持不变，模型入口恢复地图工具与路线卡，用户仍可不经过模型浏览地图。校园导入按来源/学校/学期/领域合并；partial 空结果不清空其他领域，全量、游标、冲突、tombstone 分开处理。外部读取器只接受用户配置的目录或显式环境路径，不再扫描其他项目。

`ObservationPort`、`SyncPort`、`RulePackPort`、`WatchPort`、`EntityPort`、`StorageProtectionPort` 与受审核 `TaskRecipe` 提供真实校验、版本协商和拒绝路径。媒体定位/更正、学习帮助暴露、反馈缺失、健康用途、跨设备冲突及规则版本经受控试验运行。陌生 BorrowedDevice Provider 经原 Harness 的通用 `look_up`/Recipe 路径完成取证、方案变化和撤权阻断，恶意版本被拒绝；协调器没有该名称的特例。正式产品未自动启用这些合成提供方，也未安装任意插件或赋予通用 token。

## 前台显示契约

前台默认不是 Harness 审计台。每个表面只承担一个主要问题、一个主动作和一个退路；建议、登记、执行、未知和撤销分别说清，但不把内部生命周期标签平铺。记忆页首屏只显示会影响回答的内容，其他状态进入一个次级入口；来源、条件、核验和完整回执在用户主动展开时出现。对话范围条收成一个主标签，公开草稿先展示收件人/目的/允许事实，发送能力未接入就明确说“只生成草稿”。

视觉和交互回归必须实际运行 Electron、截图并打开图像，覆盖入口、对话、记忆、连接、偏好、校园资料、安排、历史、地图、失败/恢复、浅深色、窄窗和全屏的代表状态。Apple 式只表示直接操作、因果一致、连续且可打断的反馈，不表示复制品牌皮肤；不为装饰动效或工程状态增加注意力负担。

## 迁移、删除与恢复

`PRAGMA user_version` 当前为5；第5版补充本地日历变更的版本账本。此前迁移到4的路径保留：第一版建立受控证据、理解、动作与队列；后续版本增加观察/同步、业务版本和来源根反向索引。迁移有事务与 journal。旧对话保留，旧 Memory 的 quote 无法定位时保持 unverified；旧 summary 不作证据，旧 obligations 不迁成用户承诺。

迁移已有消息库时建立同目录 `.pre-harness-v1.sqlite`。发生隐私删除后，这份由迁移创建的旧明文备份会被清除，不能继续当作安全回滚点。数据库使用 secure_delete 与 FTS secure-delete，删除后检查点清理 WAL；这不是对 SSD 历史物理块或外部副本的擦除保证。

停用保留原话但阻止旧源再次提取；纠错保存新的可追溯版本并失效相关计划/动作；新回复、工具检索、选项/目标和动作均记录实际输入来源的依赖，包含跨会话的未提取原文；删除按原文 span、来源根和派生依赖清理正文、摘要、FTS、字符索引、版本、队列及 Provider 协议链。删除屏障只含 ID/来源/定位，不保留欲忘正文。清理完成标记与清理同事务提交，重启不再抹掉删除之后新增的独立回复和草稿。

数据库旁的 `.privacy-fences.json` 是恢复屏障。先写完整临时文件，再原子替换；Windows 短暂文件占用有有界重试，失败会明确报错。恢复旧快照必须同时携带最新屏障，先应用屏障再迁移旧记录。外部导出、手工复制、已发往模型的请求或已发生的外部副作用不会被本机删除自动撤回。旧版无来源链的回复按有关会话保守处理，可能清理其中无关段落；无法证明识别所有未标注的跨会话转述，不声称全语义或物理擦除。

恢复工具默认只预览，目标必须是新建或空目录：

```powershell
npm run recover:harness -- --source D:\approved-backups\backup.sqlite --fences D:\approved-backups\latest.sqlite.privacy-fences.json --destination D:\isolated-recovery
# 核对预览后，同样的参数加 --apply，才写入新的恢复目录。
```

路径是格式示例，必须换成已授权的实际文件。工具不覆盖原库，不复制密钥，关闭外部连接/天气/提醒、清空旧审批并暂停恢复的任务，检查 integrity/FK 后留恢复报告。失败产物保留隔离，不自动激活。旧版应用不知道隐私屏障，不能直接用旧版打开已迁移或已删除内容的库。没有最新屏障就无法证明旧备份不会复活数据。

## 可复现验收

受控测试通过 `scripts/test-environment.mjs` 建立 `.test-data` 子目录，启动入口和 Store 拒绝不符合测试边界的目录，也拒绝符号链接逃逸。没有读取真实用户数据库、Key、Cookie 或无关校园目录。`scripts/harness-regression.mjs` 已改接新的隔离评估入口。

```powershell
npm run build
npm test
npm run eval:harness:offline
npm run test:harness:desktop
npm run test:desktop
npm run test:connection
npm run test:harness:trajectories
npm run test:map:core
npm run test:map
npm run package
node tests/package.mjs
npm run eval:harness:live
node scripts/check-project-docs.mjs --report
```

打包使用项目已安装并用于桌面测试的 Electron 分发（`build.electronDist`），避免再次从失效代理下载同一运行时；此配置与 [electron-builder v26 文档](https://www.electron.build/v26/docs/api/app-builder-lib.interface.configuration/#electrondist) 及本地打包器实现核对。便携成品已生成；直接启动成品 EXE 受本机应用控制策略阻止，ASAR 安全回退和限制写入 `artifacts/review/package-launch-limitation.json`。未更换 Electron 版本或模型供应商。

`test:harness:unit/state/faults/privacy/migration/extensions/controls/ports/protocol/scenarios` 可单独定位失败，底层 runner 支持 `--seed` 和 `--report-dir`。`test:harness:trajectories` 只验证 32 条新增开发轨迹的机制输入边界，并明确 L/U `not_run`；不把 gold 传给模型。`verify:harness` 运行离线机制、来源映射、真实模型配置检查、轨迹机制校验及文档门禁；桌面、地图和成品报告另行保留，不能拿机制测试代替。故障套件包括真实子进程骤停、真实 SQLite/WAL 恢复，以及本地 HTTP sink“服务成功但回执丢失”，重启核查时 sink 的 POST 计数仍为 1。

证据分四类：确定性机制与脚本语义、真实 DeepSeek 语义、真实 Electron/成品、真实外部只读。94 个场景的每个期望在执行后检查，缺 probe 就失败；ScriptedSemanticClient 不读取用例 ID 或期望答案。`harness-evidence.mjs` 从逐例结果生成 INV-01–20、X01–16、40 组覆盖映射、设计包文件校验和源码指纹，不能手写 passed。

真实模型语义评估已在显式测试授权下运行，但仍不是“通过”结论。`artifacts/harness/live-evaluation-current/live.json` 记录了 `deepseek-flash` 的 24 条（8 个 heldout 情境 × 3 个变体）真实运行：`failedRuns=0`、诊断槽位违规 0；Provider 为 `https://api.deepseek.com/chat/completions`，thinking disabled，seed 未声明。该结果证明传输、回执和当前策略链确实跑过，不证明模型正确率、情绪理解或用户满意度。

为回应“回复像不像人在照顾人”的验收重点，新增 `tests/harness/conversation-quality-corpus.json`、`scripts/score-conversation-quality.mjs` 和 `artifacts/harness/conversation-quality-final/HUMAN-REVIEW.md`。12 个小朋友/长辈、焦虑倾听、纠正、隐私草稿、一步选择和反工程复述场景均完成；可观察轨迹保留前台生成与后台抽取/核验的分层、工具调用、延迟和最终答复。基线中发现的重复答复、简单请求误触工作流、群聊私事泄露和情绪只被标记未被承接，经过受众识别、工具衔接、回复缓冲、期限保护和人本提示修复后，在当前代码的 12 场景复跑中没有出现；跨情境最终复跑另见 `artifacts/harness/live-evaluation-release/`。早期随机复跑仍出现过元话语/活动规则过度具体化，必须继续抽样。

这些是主代理的探索性逐条阅读，不是独立人类评审；隐藏 `reasoning_content` 不进入报告。启发式统计命令为 `node scripts/score-conversation-quality.mjs RUNS.json OUTPUT.json`，它只提示列表、内部术语、重复、情绪词和未来源活动规则，不能自动证明同理心。原始语义评分命令 `node scripts/score-harness-evaluation.mjs RUNS.json ADJUDICATION.json OUTPUT.json` 仍要求每次运行恰好一份独立审核；没有独立标签时 precision/recall 保持 null，不把 live 完成冒充语义通过。

## 本轮发现与修复的反例

- 删除原理解后仍保存旧安排卡：现在审批/依赖版本拒绝旧卡，明确重新生成后才能确认。
- 恢复时重复删除屏障抹掉之后的新内容：增加原子清理完成标记，旧备份与当前库分别处理。
- Windows 暂时占用侧文件：增加原子替换重试并保留旧完整屏障。
- 新范围面板浅色模式出现深底黑字：增加语义颜色，实际小窗口复查；待确认记录不再称“通常适用”。
- 临时示例曾显示可保存动作：本轮临时/只附件路径不再给出不符合保留承诺的保存入口。

本机测试与截图仅覆盖已记录情境。真实账号/连接器路径、设备或外部服务未提供的部分继续返回未连接/未授权/unsupported；它们不会阻止纯文本、本地资料和地图的独立功能。前端设计先后顺序、采用的方法与实际看图范围记在 [DESIGN](DESIGN.md#harness-design)。


