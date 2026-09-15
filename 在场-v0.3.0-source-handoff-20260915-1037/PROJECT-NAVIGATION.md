# 在场 · 项目导航

本文件是职责、当前策略、集成状态和实际文件索引的唯一维护位置。它不是学生运行时资料，也不是永久架构。检查日期：2026-09-15（Asia/Shanghai），应用 **0.3.0**。本次基线 HEAD 为 `08f95f633536fb119c5dd7c9206ccd3aa22ab81b`，工作区有大量此前未提交改动。

**本次正在实施理解与行动架构，尚未完成。** 当前进度见 [实施记录](UNDERSTANDING-ACTION-IMPLEMENTATION.md)。独自实施，后端搭建和测试通过后才使用两个前端设计技能。原生产 Harness 已切换 Hermes。DeepSeek 再次返回402后，用户指定使用 App Server 的 **GPT‑5.6‑Luna 临时代测**，生产默认不变；[代测契约与证据](LUNA-TEST-SUBSTITUTE.md)优先于下方旧轮次状态。

**最新后端状态（2026-09-13）：** V65 会话不保存但明确本地登记的问题已修复，原例/相邻反例6/6、新表达7/7；统一后端 `backend-seal-after-multimodal` 23套248/248，早于Luna新增代码。Luna适配层5项机制、真实原生函数/续接/视觉三次请求、原Harness S01/S21两故事，以及真实Electron→IPC→Hermes→Luna图文全链均通过。图文实测 `gpt-5.6-luna/textParts=1/imageParts=1`，截图已查看；当前旧UI仍写DeepSeek，需在后端门槛通过后的前端阶段纠正，不能拿截图作为界面完成证据。其余记忆/独立委派/范围切换和最终后端回归继续验证。Luna输出上限只能由宿主完成后检查，账户费用未知；不能宣称协议和语义完全等同。

<!-- app-baseline-sha256: ab176bd9b8f679b7676b4f23f2b2bf679124e7740563b7b0e51242394373828a -->

**最新状态（13:19 UTC）：仍在后端，前端技能未启用。** 主Agent与独立成稿已通过混合任务6/6、原场景9/9、真实查询成稿6/6；新模块为 `runtime/release-composer.ts`（私有准备后的隔离写作/版本与宿主交付）和 `runtime/release-store.ts`（SQL先过滤来源、归属、隐私版本再读旧稿）。`Message.responseText`/`releaseArtifacts`与原有content分工明确，派生删除改为仅保留结构字段白名单，稿件来源链进入Store依赖。对子任务新增父私密通知隔离与本任务source上限检查。当前理解专项33/33、成稿8/8、删除回归10/10、类型检查/构建通过；两次完整后端均242/243，前者删除漏字段已修，后者故障夹具缺必要依赖已修，仍需新的完整全绿证据。真实V65已证明“不保存聊天”错误阻断了明确本地登记，必须继续分开会话保留与业务效果持久化。所有测试进程已结束，下一步入口见[当前接续笔记](artifacts/understanding-action/CONTINUATION-NOTES.md)。下方带较早时间的记录仅为历史进度，不代表此刻已验收。

本次后端验证更新（09:31 UTC）：`backend-after-output-repairs` 的21套机制共225/225通过，随后记忆核验修复的理解25/25、隐私10/10、协议11/11、unit20/20及构建通过。新增职责：Provider保留长度耗尽调用的usage；控制解析最多两次并计入失败消耗；Hermes输出额度建议由宿主封顶并记录；记忆核验先解析宿主主体/现实标识，模型可取得具体拒绝理由，界面仅显示安全状态。真实S16/S40复测6/6、来源/协议新表达与反例18/18通过；180冻结批次与N09条件记忆修复仍未完成，不能把225项机制通过当作语义总门槛。活动句柄与后续检查见[接续笔记](artifacts/understanding-action/CONTINUATION-NOTES.md)。

后续更新（09:58 UTC）：180冻结记录已收齐，171通过、8任务失败、1评分耗尽未判分；原轨迹N18复判通过仅是补充证据。N09修复原例3/3、变体6/6；能力目录按语言片段检索并显式标明搜索覆盖，收尾读取相同宿主目录。收尾最多两次有界继续、结构化核验长度耗尽允许一次重试；Hermes保留原循环计数/硬停止，只更换不适用于本产品的强制继续用工具提示。最新专项理解29/29、Hermes9/9、结构化2/2及构建通过；完整225套报告仍是早于这些修改的版本。**混合本地登记与对外草稿仍失败**，后端未总验收；下一步按[主责任与对外写作调整](artifacts/understanding-action/OUTBOUND-OWNERSHIP-PLAN.md)接通单一主Agent与隔离成稿，不进入前端技能。

入口：[原则](.agents/skills/project-foundations/SKILL.md) · [定位](.agents/skills/project-navigation/SKILL.md) · [设计方法](.agents/skills/product-design/SKILL.md) · [运行与恢复](HARNESS-IMPLEMENTATION.md)

目录：[要求](#strategy) · [前台宪章](#frontstage) · [变更入口](#changes) · [职责](#responsibilities) · [User 边界](#user) · [更新](#updates) · [当前状态](#status) · [缺口](#gaps) · [场景](#scenarios) · [文件索引](#files) · [验证](#verification)

<a id="strategy"></a>
## 要求、决策与层级

| 来源 | 类型与适用范围 |
| --- | --- |
| R1 | 前轮建立项目原则、导航与设计方法的用户要求；四层知识、职责、最小必要资料与可纠正理解继续有效，前轮“仅文档”范围不限制本次实施。 |
| R2 | 用户明确选择自然语言主入口、DeepSeek、Electron（不改成 Tauri）及简洁舒适的体验；全屏阅读偏小是既有真实反馈。没有学生群体满意度研究。 |
| R3 | 用户报告独立完成天气、个人信息访问、体育等模块；路径和接口仍未提供。独立完成不等于本产品已接入，不扫描磁盘找替代品。 |
| R4（历史） | 上一轮 [05-CODEX 实施提示词](在场-Harness-人本协作设计与Codex实施包/在场-Harness-人本协作重构/05-CODEX-实施提示词.md) 的实施背景；其中子代理要求已被当前用户禁止子代理的指令覆盖。 |
| R5（当前） | 按 [02-Codex 完整实施提示词](在场-Harness-理解与行动-设计实施包/在场-Harness-理解与行动架构包/02-Codex-完整实施提示词.md) 及同包全部规格落实理解与行动型 Harness。保留仓库重要资料，独自推进，严格先后端后前端。 |
| F | 本轮代码、隔离 SQLite/HTTP sink、真实 Electron 与构建报告。模拟语义、真实模型、桌面与真实外部证据分别标注。 |
| 历史证据 | 前轮地图真机位置和校园只读记录保留原日期，不称本轮重新获取；本轮没有读取真实学生库、密钥、Cookie 或其他聊天。 |

L1 使命/受保护原则只在 `project-foundations`；L2 当前策略在本节；L3 方法在 `product-design` 和 DESIGN；L4 是可修订的实现、颜色、尺寸与文件分布。技能不是运行时授权引擎。开发子代理和 App 的受限运行时调查是不同概念；本轮子代理只做受限代码/证据协作，不获得运行时权限。

当前策略：服务在校学生，浙江大学为首个校园场景；自然语言为主要入口，直接控制按任务出现；模型保持 DeepSeek；地图 V2 已整体替换历史地图运行路径，只保留本轮 OSM 数据与当前二维组件；优先兑现来源真实、理解可改、范围可控和草稿可恢复。0.3.0 是有受控验证的桌面实现，不是已证明真实语义质量或多校通用的生产系统。

<a id="frontstage"></a>
## 长期前台宪章 · 给后续 Agent 的硬约束

这是从本轮全页面回归得到的长期设计经验。它属于 L3 方法/策略，不改变 L1 使命，也不授权运行时扩大权限。

### 先让用户看见什么

在场不是工程师的 Harness 检查台。面向正在处理生活的大学生，也要让低技术熟练度、注意力有限的人不读说明就能开始。每个页面先回答一个问题：用户现在最需要知道什么？默认只保留一个视觉焦点、一个主要动作和一个清楚退路。

### 永久禁止的前台堆叠

默认不要并列展示 `scope`、`epoch`、`receipt`、`candidate`、`provider`、`coverage`、`obligation`、source ID，或“正在使用／待确认／有原文依据／尚未核验”等工程生命周期标签。它们只在用户主动查看来源、改正理解、处理未知结果或修改数据时进入详情。

同一视线带出现三个以上同权重状态、按钮、卡片或解释时，先回到信息架构做减法；不要用更小的字、更淡的灰或更多颜色来掩盖拥挤。当前记忆页的约定是：首屏只显示“会影响回答”的内容，其余统一为“其他内容”入口。

### 状态表达

先说结果和下一步，再说依据。建议、已登记、已执行、未知、需到原服务确认必须分开，但每次只突出当前一个状态。来源、核验和完整条件渐进披露；错误、撤销和恢复贴近触发点。简洁不等于隐藏控制，舒适不等于伪装成功。

### Apple 式体验的可迁移部分

可以借鉴 Apple 等平台的直接操作、因果一致、连续反馈、安静层级、可打断动效和熟悉控件；不复制品牌皮肤，不把圆角/字体/颜色/模糊/某条缓动曲线当原则。动态只用来解释打开、切换、保存、撤销、返回和恢复，必须尊重键盘、减少动态效果、窄窗和长内容。

### 设计回归门槛

任何前端改动都要运行真实 Electron，打开截图查看，并操作入口、核心结果、失败/恢复、记忆、连接、安排、地图、浅深色、窄窗和全屏的适用代表状态。报告使用“已查看/已操作/未验证”，不能把代码采用、截图、脚本通过或 Agent 自评写成用户喜欢。完整约定在 [product-design Skill](.agents/skills/product-design/SKILL.md) 与 [DESIGN 方法证据](DESIGN.md#method-evidence)。

<a id="changes"></a>
## 变更入口

| 任务 | 先读入口 | 必须连同检查 |
| --- | --- | --- |
| 本轮范围、临时输入、撤权 | `main.ts` → `runtime/policy.ts`、`discourse.ts` → `storage/repository.ts` | 保存前判断、SQL 过滤、epoch/版本、Provider opaque 链、renderer 草稿 |
| 理解、当日例外、纠错/停用/删除 | `memory/service.ts`、`memory/model.ts`、`HarnessViews.tsx` | 原文 CP 定位、条件/期限、版本冲突、旧源再提取、派生链与恢复屏障 |
| 上下文和长输入 | `runtime/context.ts`、`coordinator.ts`、`harness.ts` | TaskNeeds、完整条件束预算、原文兜底、连续水位与实际 receipt |
| 目标、拒绝理由、方案变化 | `runtime/work.ts`、`capabilities/broker.ts` | 现实/假设隔离、依赖补查、稳定选项、取消后的 watch/action |
| 保存安排、未知结果、提醒 | `actions/runtime.ts`、`actions/reminders.ts`、`action` IPC | 参数/受众/版本/期限审批、执行前复核、重启核查、OS 回执能力 |
| 校园导入、只读连接、规则 | `storage/domains.ts`、`capabilities/builtin.ts`、`zjuAdapter.ts`、`ports.ts` | source/institution/term、partial/full、冲突/游标、权限与新鲜度 |
| 地图或定位 | `src/renderer/map/` → map IPC → `mapService.ts` / `mapLocation.ts` | 使用当前 OSM 资格与拓扑、旧响应失效、未知入口不画假线；地图 UI 不依赖模型 |
| 新能力/媒体/跨设备 | `shared/harness.ts`、`capabilities/broker.ts` / `ports.ts` | 受审核 manifest/schema、权限、状态、模拟标签和取消；不自动执行第三方代码 |
| 接口/插件管理 | `main/interfaces/manager.ts`、`main/plugins/manager.ts`、`main/plugins/runner.ts`、`capabilities/broker.ts`、`SettingsPanel.tsx` | 统一目录、启停、权限/出站范围、持久化；第三方 ZIP 包安装/升级/卸载先写用户目录，重启后切换；插件入口在独立进程运行，网络回到宿主受控通道 |
| 源码冷启动与实时更新 | `scripts/start-dev.vbs`、`scripts/start-dev.cmd`、`scripts/dev.mjs`、`src/main/main.ts` | 桌面快捷方式通过隐藏的 Windows 启动器进入 Vite/Electron；开发服务器把实际端口传给 Electron，保留 Vite HMR；源码测试版使用 `%LOCALAPPDATA%\Zaichang\source-dev`，并忽略历史 `.dev-data`，避免与已安装版争抢缓存，也不让 Vite 监听 Electron 缓存 |
| 体验或全面设计 | 当前用户任务 → L1/L2 → 两个设计技能 → `App` / `SettingsPanel` / `HarnessViews` | 原输入、地图、草稿、来源、失败与恢复；实际截图必须打开查看 |
| 迁移/回滚/验收 | `storage/repository.ts`、`harness-recover`、`test-environment` | 最新屏障先于旧记录迁移、新目录恢复、无生产凭据的可复现命令 |

<a id="responsibilities"></a>
## 概念职责与真实代码

| 职责 | 拥有的真相与实际入口 | 边界 |
| --- | --- | --- |
| D1 对话与体验 | App、SettingsPanel、HarnessViews、ui，经有限 Bridge/IPC 发起明确操作 | 不存密钥，不决定官方真假；展示来源、覆盖和回执而非隐藏推理 |
| D2 用户理解 | MemoryService 的 Assertion、Condition、Temporal、Verification，模型候选经唯一 writer | 当前状态、偏好、事实和未确认推断分开；不建立固定人格或凭偏好推授权 |
| D3 校园与个人事务 | DomainService 的版本事实；WorkService 的 Goal/Plan/Commitment/Task；本地 agenda | 官方记录、自述、愿望、提议、接受与完成分开；不复制万能 User 台账 |
| D4 空间与环境 | 当前地图 V2、源路由、Windows 位置；天气经内建只读 Provider | OSM 不是实时门禁，低精度不当精确起点，杭州预报不代表用户位置 |
| D5 历史与证据 | Repository 的 EvidenceEvent/Span/FTS/字符索引/原文，ContextCompiler 与连续水位 | 旧 summary 不作为证据；先限制范围再读取；引用/外部正文不是执行指令 |
| D6 判断与规划 | 原 Harness → 固定Hermes/RuntimeCoordinator/ContextCompiler/WorkService/DeepSeek | 主模型负责语义；宿主负责状态、权限、计算与真实回执。已有真实开发样本，最新代码完整重复仍因余额不足待测 |
| D7 行动与提醒 | ActionRuntime 的审批/尝试/回执与 ReminderRuntime 的队列/lease/fence/dedup | unknown 不当成功；本机 done 不当官方计次；关闭 App 无常驻提醒保证 |
| D8 接入与同步 | Broker/InterfaceManager 内建 Provider、插件子进程、受限 zju 子进程、Observation/Sync/RulePack 等 Ports | 只用明确配置路径；partial 不清其他域；第三方插件默认停用，不能自授 scope；外部正文、Skill、MCP 都不提升权限 |

横切身份由可信宿主生成 principal/workspace/device，ScopeHandle 不可伪造；用途、受众、来源、主体、世界、期限、epoch 与 revision 贯穿读取和写入。它是单机逻辑边界，不是完整账号登录或 OS 沙箱。安全 IPC、CSP、contextIsolation/sandbox 和 safeStorage 延续；SQLite 正文仍未整体加密。

<a id="user"></a>
## User：统一入口，分别拥有真相

| 对象 | 当前实现及归属 |
| --- | --- |
| Account/Identity | 宿主身份与 scope 校验；尚无多账号登录/设备认证产品。sessionId 只标对话。 |
| Profile / Preferences | D2 的可追溯条件断言、状态/期限/版本；按任务读取，不每轮塞入全部偏好。 |
| Personality | 可为空，未确认推断不升为硬限制，不自动分类或诊断。 |
| Interaction policy | 当前原话的参与要求、设置与注意力预算；旧listen/hint兼容字段不作生产语义裁决，也不等于外部动作授权。 |
| Current state | 有时间范围的断言与本轮确定性覆盖，原话仍保留；健康用途与事实分类是两条轴。 |
| Academic/activity records | D3 分域官方/导入记录；学校/学期/来源有独立标记，自述完成不覆盖官方累计。 |
| Goals / commitments | WorkService 独立实体；目标须用户采用，消息 obligations 仅本轮工作步骤。 |
| Conversation / evidence | D5 保留原交流、附件来源、定位、版本和处理状态；反馈结果缺失明确记录。 |
| Consent / access policy | 宿主策略、即时 barrier 与恢复屏障；扩展不能自授 scope 或 token。 |

影响判断的元信息包含：所有者、主体、世界、原始来源与定位、事实/推断等级、发生/有效时间、获取时间、版本/替代/失效、学校学期范围、允许用途/受众及保留方式。结构合法不等于语义正确，来源存在也不自动证明官方真实性。真实健康或学生资料没有作为本轮 fixture。

<a id="updates"></a>
## 更新责任链与最小上下文

原输入 → 保存前策略与可信 scope → 证据/分段/outbox 同事务 → 候选提取和核验 → 唯一提交 → 依赖失效 → 当前任务 ContextContract/TaskNeeds → 授权检索与完整条件束 → 模型/Provider → 可审阅结果与真实 receipt。

“今天不想跑”是当日状态；“不再提醒”处理对应目标/提醒；“学校已计入”须校方来源；“我跑完”仍是自述。纠错与现实后来变化分别走 CORRECT / SUPERSEDE；例外不抹掉原规则。暂停目标不会自动重新开启旧提醒，恢复后需核对。

停用、纠错、删除不是同一操作。删除清理来源 span、派生理解/计划/动作、摘要、FTS/字符索引、队列及 opaque 模型链，且恢复旧备份必须应用最新屏障。已清理库保存事务完成标记，重启保留删除之后的新内容。外部副本与已经派发的副作用不宣称撤回。

选择资料先于正文访问。条件/例外成束入预算，中文短词和原文有独立通道，未提取尾部仍可按本轮范围使用；received/extracted/indexed 是连续水位，不取 max 伪装全部完成。公开草稿只获得允许披露的投影；只附件和只吐槽不会查全私人资料。

<a id="status"></a>
## 当前实现、运行证据与未连接项

两轴分别看：实现/接入等级，以及这次实际运行状态。历史或模拟成功不自动升级为真实服务可用。

| 能力 | 实现/接入事实 | 本轮证据与界限 |
| --- | --- | --- |
| 原输入到Hermes Harness | 原main/preload/Harness接固定Hermes AIAgent；保存前范围控制、开放共同理解/明确请求、原文检索、受控工具和回执 | 本次离线后端217/217（含92个迁移后的宿主场景），核心26/26；真实开发与B0–B3见当前报告。本次Electron界面尚未验收 |
| 条件理解与本轮控制 | 候选/核验/统一提交、期限、原话、纠错/停用/删除；交互姿态与读取/本地登记分离；后台记忆不阻塞首答 | 确定性机制与原入口回归通过；真实 DeepSeek 已完成有界实测，但独立语义/人类体验评分仍未作为通过门槛 |
| 目标、方案、反馈 | 独立 work/world、版本与依赖，目标采用/暂停/取消、理由反馈 | 受控机制和 UI 测试；接受不算真实成功，未证明学生满意度 |
| 动作与提醒 | 本地保存已接入；明确、参数充分且可撤销的本人登记可由宿主 direct_local 直接执行并给撤销；外部审批/派发/核查/取消契约可运行 | HTTP sink 丢回执/重启/一次 POST，OS 只声称提交；正式外部写服务未连接 |
| 校园资料 | 按域/source/institution/term 合并，full/partial/failed/冲突；显式目录的 zju 读取器桥 | 合成导入/受限子进程/状态测试；本轮没有真实账号、目录或同步 smoke |
| 地图 V2 | 当前二维组件、533 栋建筑、608 个可搜索地点（含核心地标与官方名称别名）、25 栋有可路由入口；运行入口已移除历史地图资源 | 22 项核心测试、覆盖审计与真实 Electron 地图回归；未知入口和低精度测试有明确失败状态 |
| Windows 位置 | 系统位置桥；短生命周期、取消、不保存轨迹；地图与天气使用独立请求实例，互不取消 | 本轮天气 GPS 链路以合成定位回归验证；真实 Electron 已验收定位开关，不触发系统隐私设置；历史 `native-location.json` 为独立真机证据，不作本轮再验证 |
| 接口管理器 | 已登记 Provider 的统一目录、中文说明、启停、权限/出站范围和持久化；设置页支持第三方 ZIP 插件安装、版本升级、待重启卸载；插件入口进独立进程，网络由宿主中转；插件清单可声明并由宿主校验 Agent-facing 输入/输出 schema，坏升级自动回滚上一已知版本 | `test:interfaces` 2/2、`test:plugins` 8/8、构建通过；示例天气 ZIP 可由 `npm run package:weather` 生成并通过清单检查；真实 Electron 尚未用真实插件包执行 UI 安装 |
| 源码冷启动 | 桌面快捷方式已改用隐藏的 `scripts/start-dev.vbs`，由 `scripts/start-dev.cmd` 保留手动诊断入口；启动器使用本机 Node.js，Vite 监听 5173（被占用时传递实际端口），Electron 通过 `ZAICHANG_DEV_SERVER_URL` 加载，源码资料写入 `%LOCALAPPDATA%\Zaichang\source-dev` | 已从桌面快捷方式冷启动并查看真实 Electron 首页；已修改首页文案验证 HMR 即时更新，再恢复原文；旧 `.cmd` 换行问题已修复；本次需确认隐藏启动和缓存隔离 |
| 悬停控件 | `tokens.css` 的 `--control-hover` / `--control-hover-text`，由 `style.css`、`refinements.css` 与最终的 `harness.css` 统一应用于图标、建议和次要按钮 | 用户反馈后改为 `#454745` 炭灰悬停并使用浅色前景；`scripts/check-theme.mjs` 已在真实 Electron 浅色主题中通过悬停断言并生成截图；关闭按钮红色语义保留 |
| 天气 | 天气已移出 `builtin.ts`，作为可安装的 `weather` 插件提供 `weather.lookup`、`weather.forecast`、`weather.outdoor_activity`；Agent 入口动态解析已安装能力；宿主负责 Windows 定位和权限，插件通过受控 Open-Meteo 通道取数 | `test:weather-gps` 3/3、`test:plugins` 8/8、构建通过；打包/清单检查通过；未做真实天气网络 smoke，未做真实 Electron 插件 UI 安装 |
| DeepSeek | 当前官网提供方为 DeepSeek，端点 `https://api.deepseek.com/chat/completions`，唯一请求 ID `deepseek-flash`；2026-09-13 官方映射为 **DeepSeek-V4.1-Flash** 原生多模态模型；旧设置、renderer 和评估环境变量不能覆盖，不使用 V4/Pro/chat/reasoner 兼容名；SSE/tool calls、thinking/strict、text+image 同消息；图片本机缩放/转 JPEG 后仅随当前用户消息进入模型，不进入文字记忆提取；Key 在仓库外由 Windows DPAPI 保护 | 历史官网直连与旧入口Electron图文验证成功；新的Hermes图文传输已通过合成引擎检查，最新Electron真实图文尚待余额恢复后复测。历史请求均为 `deepseek-flash`、1 text part + 1 JPEG image part，模型正确把右侧视觉位置用于文字条件和日常提醒；官方改映射时须重新核对与重跑真实验收，仍不是通用视觉正确率证据 |
| 陌生扩展 | BorrowedDeviceProvider + Recipe 经通用主路径接入与撤权，恶意 manifest/网络/泄漏被拒绝 | 只在隔离 fixtures 注册，不随 App 自动启用，不是 OS 沙箱 |
| 未来公共接口 | Observation/Sync/RulePack/Watch/Entity/StorageProtection 等实际校验、版本/冲突、拒绝与模拟路径 | X01–X16 对应受控场景；真实媒体采集、跨设备账号、健康/学习设备与通知服务未连接 |
| 独立天气/个人信息/体育 | 保留 R3 用户报告，路径和真实协议缺口未补造 | 没有扫描无关项目或读取真实学生数据，不能用本产品内建适配替代其接入证明 |
| 图片 | 原“＋”菜单已接 JPG/PNG/WebP；本机缩放、移除 EXIF 并转 JPEG；草稿长条、发出后紧凑缩略图和点击大图预览共用现有对话入口 | 历史Electron契约与官网真实请求通过；本次增加“后续纯文字轮不重放旧图”的机制验证，最新Electron UI未验收；8 MB 原图、1600px/3M data URL 边界；尚非多图/PDF/摄像头采集 |
| 语音、PDF/压缩包、邮件、钉钉、预约、手机 | 没有实际服务或设备连接；UI 不提供假可用入口 | unsupported/未连接；激活需要明确模块/设备/账号与审核配置 |

当前理解与行动证据位于 `artifacts/understanding-action/`。以下是早期版本的历史基线，不是新Hermes入口的当前验收：旧后端证据为 [离线汇总](artifacts/harness/offline-evaluation/tests.json)、[轨迹机制校验](artifacts/harness/trajectory-validation/REPORT.md) 与真实 Electron/IPC 报告；当前机制套件 175 项、原 94 场景 94/94、新 32 条开发轨迹 32/32。Windows 便携版已生成；桌面/地图/成品回归在资源串行运行时通过。直接启动便携 EXE 受本机应用控制策略阻止，ASAR 安全回退探针与限制记录见 `artifacts/review/package-launch-limitation.json`；真实模型语义、外部服务与 U 体验证据独立保留。设计复查见 [DESIGN](DESIGN.md#harness-design)。

<a id="gaps"></a>
## 已闭合的机制差距与仍缺的证据

| ID | 当前结论 | 不能夸大的部分 |
| --- | --- | --- |
| G1 | 固定全 Profile 注入已替换为范围先行、任务需求和完整条件束；已做有界真实 DeepSeek 体验样本 | 正式语义召回率/个性化收益与独立人类评分仍未测，词法/小样本不是通用理解保证 |
| G2 | 删除已穿透本机派生链、索引、旧 worker/协议链与恢复屏障，重启回归含正向保留 | 外部请求/副本、SSD 物理块、遗失屏障的旧备份不能保证撤回或擦除 |
| G3 | 主体/世界/用途/受众/期限/版本有受控运行契约 | 没有生产多账号、云认证或跨设备部署 |
| G4 | 独立模块没有授权路径/接口仍保留缺口 | 不扫描、不重造替代项目；需要真实提供者材料 |
| G5 | 校园分域与 RulePack 学校/学期版本已实现 | 没有专用成绩学分产品、各校完整规则或真实外部预约 |
| G6 | 依赖失效、最小修订、资源理由 TTL、目标/提醒取消已机制化 | 不称任意自然语言变化都会被真实模型正确识别 |
| G7 | 单机受控测试、截图和成品证据可复现；真实 DeepSeek 有界 heldout 与人类体验样本已留存 | 缺独立人类标注、可复现 seed、学生研究、长期/跨平台运行证据；不能把完成样本称语义通过 |
| G8 | partial 体育更新不会清课表，全量/游标/版本冲突有测试 | 独立体育源仍须提供官方来源、认证与实际接口 |
| G9 | 既有 OSM 地图快照仍有效保留 | 多数建筑入口、实时门禁、手机位置未补齐，未知连接不伪造 |

尚未成立的推断：所有学生都适合固定人格/长块学习、当前外观必然提高满意度、接口 schema 等于真实服务、单次成功等于重试安全。后续外部依赖是 DeepSeek 账号可用余额（Key 已获授权并保存）、未接入连接器/设备的真实协议和测试账号，以及独立语义/学生体验审核；代码和受控路径不能以“待接入”为由留空。

<a id="scenarios"></a>
## 场景与证据定位

| 情境 | 验证入口与判断 |
| --- | --- |
| 当日例外、未来搬家、纠错、两字简称、长消息尾部 | `unit/state/scenarios`；断言条件/期限、原文及 context receipt，不只比较回复措辞 |
| 只附件、代问、假设、公开草稿、临时不保存、注入正文 | `privacy/scenarios` 与原 UI；SQL、模型 payload、写库和动作分别检查 |
| 图片+文字联合理解、草稿预览、发出后缩略图/手动大图 | `test:deepseek:vision`、`test:multimodal`、`test:multimodal:live`；分别检查官网能力、Electron 合成契约和真实全链 |
| 索引迟到、seq 缺口、重复与冲突、骤停恢复 | `unit/faults/migration`；真实 SQLite/WAL 与子进程退出 |
| 删除、撤权、旧备份及删除之后的新草稿 | `privacy/migration/controls/connection`；屏障与原入口重启，既检查清理也检查合法保留 |
| partial 导入、体育不清课表、低精度/未知入口 | `ports/scenarios`、`map:core/map`；来源/范围与失败状态 |
| 外部成功丢回执、不可核查、重复确认、目标取消 | `faults/state/controls`、原安排页；sink 计数和持久状态 |
| 陌生能力、恶意版本、媒体/学习/反馈/规则/同步 | `extensions/ports/scenarios`；公共路径与拒绝/升级语义，不冒充真实集成 |
| 版本编辑、期限/范围、未知回执、地图返回和窄窗 | `test:harness:desktop`、`desktop/connection/package`；实际点击/输入/截图与持久化 |

<a id="files"></a>
## 实际文件索引

索引说明职责和清点范围，不把每个文件存在等同已运行。新 Kernel 目录各自有真实职责；测试/产物与真实个人资料严格分开。目录组覆盖其实际子文件；设计包原件与用户归档保留。
<!-- owned-file-index:start -->
| 相对路径 | 作用 / 当前关联职责 | 阅读范围 |
| --- | --- | --- |
| [AGENTS.md](AGENTS.md) | 极短开发路由，保留用户的子代理模型路由指令 | 既有；本轮核对 |
| [.agents/skills/project-foundations/SKILL.md](.agents/skills/project-foundations/SKILL.md) | L1 使命/原则、层级边界与重大修订 | 既有；本轮核对 |
| [.agents/skills/project-navigation/SKILL.md](.agents/skills/project-navigation/SKILL.md) | 定位、核验和更新此索引的方法 | 既有；本轮核对 |
| [.agents/skills/product-design/SKILL.md](.agents/skills/product-design/SKILL.md) | 有条件的项目设计方法与证据入口 | 既有；本任务按用户要求尚未加载/使用 |
| [PROJECT-NAVIGATION.md](PROJECT-NAVIGATION.md) | 当前职责、策略、状态、User 契约与唯一文件索引 | 既有；本轮核对 |
| [README.md](README.md) | 产品使用/开发命令及到导航的入口，不维护第二份目录 | 本轮修订 |
| [DESIGN.md](DESIGN.md) | 前轮设计记录与本轮方法证据附录，非永久架构约束 | 本轮修订 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 依赖及字体许可说明、Hermes 参考边界 | 全读 |
| [package.json](package.json) | 命令、依赖、Electron 入口与 Windows 打包声明 | 全读 |
| [package-lock.json](package-lock.json) | npm 依赖锁定，按文件清点/摘要校验，不逐包审计 | 清点 |
| [tsconfig.json](tsconfig.json) | TypeScript 编译范围与严格检查 | 全读 |
| [vite.config.ts](vite.config.ts) | renderer 构建及本机开发服务 | 全读 |
| [index.html](index.html) | renderer 文档入口和 CSP | 全读 |
| [.gitignore](.gitignore) | 依赖、构建、临时库及环境文件忽略范围 | 全读 |
| [.prettierignore](.prettierignore) | 格式化排除范围 | 全读 |
| [.prettierrc.json](.prettierrc.json) | 格式化约定，可替换实现 | 全读 |
| [src/main/main.ts](src/main/main.ts) | Electron/IPC、凭据、文字/图片选取与本地图像归一化、导入/动作/通知入口；D7/D8/横切 | 全读 |
| [src/main/preload.ts](src/main/preload.ts) | D1 到主进程的有限 Bridge 暴露 | 全读 |
| [src/main/harness.ts](src/main/harness.ts) | D5/D6 上下文、循环、状态、取消、只读分身 | 全读 |
| [src/main/provider.ts](src/main/provider.ts) | 宿主固定 DeepSeek `deepseek-flash`，SSE、图文 content parts、工具参数片段、错误与重试 | 全读 |
| [src/main/model-selection.ts](src/main/model-selection.ts)、[src/main/luna-provider.ts](src/main/luna-provider.ts) | 仅宿主选择的Luna临时代测；同一Harness模型接口，原生Responses图文/函数/加密协议续接，App Server单请求认证与内置执行隔离 | 机制5项、真实工具/视觉、S01/S21与Electron图文通过；更广回归进行中 |
| [LUNA-TEST-SUBSTITUTE.md](LUNA-TEST-SUBSTITUTE.md) | 用户授权的代测身份、架构边界、命令、输出预算差异及证据限制 | 本次说明 |
| [scripts/run-luna-test.mjs](scripts/run-luna-test.mjs)、[scripts/probe-luna-transport.ts](scripts/probe-luna-transport.ts) | 无DeepSeek Key的代测启动、三请求原生工具/随机代码续接/文字图像联合理解探针 | 真实探针通过 |
| [tests/luna-provider.test.ts](tests/luna-provider.test.ts)、[tests/fixtures/luna-app-server.mjs](tests/fixtures/luna-app-server.mjs) | 单次App Server合成wire服务、传输替换与拒绝/取消/默认路由机制 | 5/5 |
| [tests/harness/live-model.ts](tests/harness/live-model.ts) | 各理解与行动评测入口共享真实提供方选择与代测预算身份，Luna费用不套DeepSeek价格 | 类型检查；真实各专项按批次记录 |
| [tests/harness/evaluation-time.ts](tests/harness/evaluation-time.ts)、[tests/evaluation-time.test.ts](tests/evaluation-time.test.ts) | 评分器独立换算ISO时区，不把06:00Z误判为上海06:00；保留原工具证据和答复 | UTC/偏移/跨日/夏令时机制；原轨迹复判单列 |
| [tests/harness/long-input-review.test.ts](tests/harness/long-input-review.test.ts) | 无工具长原话也核验遗漏并有界修复；短交流不强制收尾/工作对象，不追加动作 | 新增长输入回归，独立真实批次复验 |
| [scripts/summarize-understanding-usage.mjs](scripts/summarize-understanding-usage.mjs)、[tests/understanding-usage.test.mjs](tests/understanding-usage.test.mjs) | 汇总可信实际调用并去重，区分未知usage/费用与Luna账户用量，不采纳模型嵌入伪账单 | 4/4 |
| [src/main/tools.ts](src/main/tools.ts) | 工具注册/schema/可用性；检索、快照、天气、理解候选、计划/分派 | 全读 |
| [src/main/zjuAdapter.ts](src/main/zjuAdapter.ts) | 外部浙大读取器的受限子进程桥、全量摘要、按领域读取、刷新与连接状态 | 本轮修订/选读 |
| [src/main/mapService.ts](src/main/mapService.ts) | 当前 OSM 地点查询、多入口步行最短路与失败状态；无历史地图依赖 | 当前实现；回归验证 |
| [src/main/store.ts](src/main/store.ts) | SQLite 持久化承载 D2/D3/D5/D7；不是语义所有者总和 | 全读 |
| [src/main/interfaces/manager.ts](src/main/interfaces/manager.ts) | 已登记接口的目录、启停、状态/权限投影和状态持久化 | 本轮新建；由 RuntimeCoordinator 接入 |
| [src/main/plugins/manager.ts](src/main/plugins/manager.ts) | 第三方 ZIP 清单校验、路径安全、版本注册表、待重启安装/升级/卸载、Agent-facing schema 校验及坏升级回滚 | 本轮新建/修订；`test:plugins` 8/8 |
| [src/main/plugins/weather-adapter.ts](src/main/plugins/weather-adapter.ts) | 宿主侧天气插件适配：在位置权限通过后注入标准坐标，不让天气插件依赖 Windows API | 本轮新增；`test:weather-gps` 3/3 |
| [src/main/plugins/runner.ts](src/main/plugins/runner.ts) | 插件入口独立进程与宿主 JSON-RPC/受控网络请求协议 | 本轮新建；runner 协议测试通过 |
| [src/main/demo.ts](src/main/demo.ts) | 标注为本地体验的合成响应/步骤，不是实际模型调查 | 全读 |
| [src/main/md.d.ts](src/main/md.d.ts) | Markdown 文本导入声明 | 全读 |
| [src/shared/types.ts](src/shared/types.ts) | 当前 Message/Draft 图文附件、固定 DeepSeek 模型、Memory/Action/CampusSnapshot/Bridge 等 DTO | 全读 |
| [src/shared/interfaces.ts](src/shared/interfaces.ts) | Renderer 安全的接口管理 DTO；不暴露 Provider schema | 本轮新建；由 Bridge/SettingsPanel 使用 |
| [src/shared/plugins.ts](src/shared/plugins.ts) | 安装插件生命周期与 Renderer 安全状态 DTO | 本轮新建；由 Store/Bridge/SettingsPanel 使用 |
| [src/shared/schemas.ts](src/shared/schemas.ts) | 导入事件/设置/动作校验与检索词处理 | 全读 |
| [src/shared/limits.ts](src/shared/limits.ts) | 输入与附件总预算常量 | 全读 |
| [src/shared/map-v2.ts](src/shared/map-v2.ts) | MapOverview/MapRoute/MapPoint/LocationStatus 结构化契约 | 既有；本轮核对/全读 |
| [src/renderer/main.tsx](src/renderer/main.tsx) | React、字体与基础/覆盖样式的加载次序 | 全读 |
| [src/renderer/App.tsx](src/renderer/App.tsx) | 聊天、草稿/图文附件归属、原上传菜单、发出后缩略图/手动预览、历史、行动卡 | 选读：主状态/发送链、MessageView/ActionCard、输入菜单与恢复 |
| [src/renderer/SettingsPanel.tsx](src/renderer/SettingsPanel.tsx) | 连接/资料/记忆/偏好，动作级反馈与数据控制 | 选读：状态/切换/测试、各资料与记忆入口 |
| [PLUGIN-SDK.md](PLUGIN-SDK.md) | 第三方 ZIP 包结构、manifest、入口脚本、Agent-facing schema 和宿主 request 协议 | 本轮新建/修订；与插件运行时保持一致 |
| [examples/weather-plugin/](examples/weather-plugin/) | 可安装天气插件示例：日预报、逐小时预报、户外活动建议；不直接访问 Windows API 或网络 | 本轮新增；`npm run package:weather` 生成安装 ZIP |
| [scripts/package-weather-plugin.mjs](scripts/package-weather-plugin.mjs) | 将天气插件清单和入口打成在场 ZIP 包 | 本轮新增；打包与 `inspectPluginArchive` 检查通过 |
| [src/renderer/ui.tsx](src/renderer/ui.tsx) | Portal、按钮、Modal 焦点/动效、Switch | 全读 |
| [src/renderer/global.d.ts](src/renderer/global.d.ts) | window.zaichang 类型入口 | 全读 |
| [src/renderer/tokens.css](src/renderer/tokens.css) | 当前色彩、输入/阅读宽度与字号参数，L4 | 全读 |
| [src/renderer/style.css](src/renderer/style.css) | 基础组件、布局与交互样式 | 选读：主要 class、响应式与减少动效；后加载 refinements 会覆盖 |
| [src/renderer/refinements.css](src/renderer/refinements.css) | 前轮两次重设计的比例、披露与状态覆盖 | 选读：阅读/输入分离、卡片、入口标识、断点与动效 |
| [prompts/system.md](prompts/system.md) | App 基础系统提示词；不是开发 Skill 或运行时授权引擎 | 全读 |
| [prompts/campus-tools.md](prompts/campus-tools.md) | 校园按需读取、分域来源与显示规则；不是授权协议 | 既有；本轮核对 |
| [prompts/map-tools.md](prompts/map-tools.md) | 地图/路线/位置来源、状态、跨厂商接口和隐私规则 | 既有；本轮核对 |
| [examples/campus.example.json](examples/campus.example.json) | 合成逐次日程/取消事件的导入格式 | 全读 |
| [scripts/build-electron.mjs](scripts/build-electron.mjs) | esbuild 主进程/preload 打包 | 全读 |
| [scripts/dev.mjs](scripts/dev.mjs) | 构建并启动 Vite/Electron；把 Vite 实际开发地址传给 Electron，保留 HMR | 全读；按命令范围使用 |
| [scripts/start-dev.cmd](scripts/start-dev.cmd) | Windows 冷启动包装器；切换到项目目录、解析 Node.js 并保留启动错误信息 | 本轮新建；桌面快捷方式使用 |
| [scripts/start-dev.vbs](scripts/start-dev.vbs) | 隐藏开发控制台并启动源码版 Node/Vite/Electron；Electron 窗口仍正常显示 | 本轮新建；桌面快捷方式使用 |
| [scripts/with-deepseek-key.ps1](scripts/with-deepseek-key.ps1) | 从仓库外的当前用户 DPAPI 凭据中解密 DeepSeek Key，只在被包装命令的进程树中临时注入，不回显 | 本轮新建；状态/子进程注入已验证 |
| [scripts/probe-deepseek-vision.mjs](scripts/probe-deepseek-vision.mjs) | 用无个人信息的项目图标直连官网验证图像+文字规则的联合理解 | 本轮新建；真实网络已运行 |
| [scripts/inspect.mjs](scripts/inspect.mjs) | Playwright 启动检查窗口并等待关闭，使用指定测试目录 | 全读；按命令范围使用 |
| [scripts/test.mjs](scripts/test.mjs) | 编译并运行 core.test 的入口 | 全读；本轮运行 |
| [scripts/test-weather-gps.mjs](scripts/test-weather-gps.mjs) | 编译并运行天气 GPS 链路测试，自动加载 Markdown 依赖并使用临时产物 | 本轮新建；`test:weather-gps` |
| [scripts/create-icon.py](scripts/create-icon.py) | 生成自有几何图标资源 | 全读；按命令范围使用 |
| [scripts/check-project-docs.mjs](scripts/check-project-docs.mjs) | 文档引用/索引/基准检查，不启动 App | 既有；本轮核对 |
| [tests/core.test.ts](tests/core.test.ts) | Store/provider/tool/harness 核心合成测试 | 选读：测试定义与关键断言 |
| [tests/desktop.mjs](tests/desktop.mjs) | Electron 示例流程、响应式和部分交互测试 | 选读：入口、隔离目录、检查/截图与报告 |
| [tests/connection.mjs](tests/connection.mjs) | 模拟 SSE 经真实 IPC/SQLite/harness 的契约流程 | 选读：传输替换、隔离、关键断言和报告；不是生产 API 验证 |
| [tests/multimodal-ui.mjs](tests/multimodal-ui.mjs) | 原上传菜单→图片归一化→IPC→Harness→DeepSeek 的合成/官网真实双模式验收，并截取浅深色、窄窗、缩略图和手动预览 | 本轮新建；两种模式已运行 |
| [tests/map-v2.mjs](tests/map-v2.mjs) | 真实 Electron 的地图入口、路线、交互、异常、布局与录像验收，使用隔离资料 | 当前实现；回归验证 |
| [scripts/check-theme.mjs](scripts/check-theme.mjs) | 主题/暗亮色可读性静态检查 | 选读 |
| [assets/map-v2/](assets/map-v2/) | 本轮重新取得的 OSM 原始地理数据、源说明、地点、路网与版本清单；ODbL | 当前地图资料；回归验证 |
| [public/map-v2/](public/map-v2/) | 本地 app 协议加载的新二维 GeoJSON、地点和来源数据，无栅格底图 | 当前地图资料；回归验证 |
| [tests/package.mjs](tests/package.mjs) | 成品启动/渲染与安全参数检查 | 全读；会启动打包程序，不能当纯文档校验执行 |
| [MAP-V2.md](MAP-V2.md) | 地图使用、数据范围、来源与重建/验证说明；状态真相仍在本导航 | V2 新建 |
| [scripts/audit-map-coverage.mjs](scripts/audit-map-coverage.mjs) | 源几何、命名对象、核心地标与当前官方名称层的多轮覆盖审计 | 当前实现；已运行 |
| [assets/map-v2/core-reference.json](assets/map-v2/core-reference.json) | 求是大道、西/东操场、湖泊与校门等核心覆盖清单及来源边界 | 当前数据；已核对 |
| [assets/map-v2/official-coverage-reference.json](assets/map-v2/official-coverage-reference.json) | 当前公开官方 WFS 的名称交叉索引与 25 米内别名映射，不含官方 2.5D 面 | 当前数据；已核对 |
| [src/main/mapLocation.ts](src/main/mapLocation.ts) | Windows 系统位置服务桥，短生命周期与取消；不储存坐标 | V2 新写/真机服务已测 |
| [src/shared/map-routing.ts](src/shared/map-routing.ts) | 源节点图、Dijkstra、多入口与坐标/位置有效性 | 当前实现；回归验证 |
| [src/renderer/map/](src/renderer/map/) | 新地图 UI、二维引擎、选择/相机状态、单色变量与样式 | V2 新写/实测 |
| [scripts/import-map-v2.mjs](scripts/import-map-v2.mjs) | 有界 OSM JSON/gz 归一化；保留几何和拓扑，拒绝虚构连接 | 当前实现；回归验证 |
| [scripts/build-official-coverage-reference.mjs](scripts/build-official-coverage-reference.mjs) | 从当前公开 WFS 名称层生成空间交叉索引，不复制官方 2.5D 几何 | 当前实现；已运行 |
| [scripts/fetch-map-v2.mjs](scripts/fetch-map-v2.mjs) | 用户显式执行的有界数据更新；应用启动不抓取 | V2 新写 |
| [scripts/verify-map-optimality.py](scripts/verify-map-optimality.py) | Gurobi 独立最小费用流路由核验；不属于软件运行依赖 | 既有地图代码；回归验证 |
| [tests/map-v2.test.ts](tests/map-v2.test.ts) | 图算法、源拓扑、特殊几何、定位与异步状态的独立测试 | 当前实现；回归验证 |
| [tests/map-browser-server.ts](tests/map-browser-server.ts) | 浏览器视觉验证后备工具；账户/定位用测试桥，不替代桌面验收，不随包发布 | 既有地图代码；回归验证 |
| [tests/interface-manager.test.ts](tests/interface-manager.test.ts) | 接口目录、启停、持久化、默认天气状态和 schema 脱敏测试 | 本轮新建；`test:interfaces` |
| [tests/plugin-manager.test.ts](tests/plugin-manager.test.ts)、[tests/plugin-runtime.test.ts](tests/plugin-runtime.test.ts) | 插件安装/升级/卸载的重启语义、路径与版本校验、Agent-facing schema、坏升级回滚、独立 runner 和宿主网络中转协议 | 本轮新建/修订；`test:plugins` 8/8 |
| [tests/weather-gps.test.ts](tests/weather-gps.test.ts) | 天气插件当前位置注入、定位失败不回退、位置权限随天气设置联动测试 | 本轮新建/修订；`test:weather-gps` 3/3 |
| [scripts/harness-regression.mjs](scripts/harness-regression.mjs) | 原有 Harness 回归工具；本轮按现有文件补齐索引 | 清点 |
| [HARNESS-IMPLEMENTATION.md](HARNESS-IMPLEMENTATION.md) | 入口、迁移、删除屏障、恢复及四类验收证据 | 本轮创建 |
| [src/shared/harness.ts](src/shared/harness.ts) | 证据/条件/作用域/工作/动作的运行时校验契约；不是设计包类型的空复制 | 本轮创建 |
| [src/main/storage/](src/main/storage/) | Repository 唯一受控 writer、SQL 范围、迁移/FTS/依赖/恢复；DomainService 分域与版本事实 | 本轮创建，机制测试 |
| [src/main/runtime/](src/main/runtime/) | Policy、discourse、ContextCompiler、WorkService、coordinator、native controls、语义/脱敏 | 本轮创建，原入口已接入 |
| [src/main/memory/](src/main/memory/) | 模型候选/独立核验、统一提交、纠错/停用/删除与旧记录迁移 | 本轮创建；临时时间标记与期限保护已修订，真实语义仍需独立审核 |
| [src/main/actions/](src/main/actions/) | 审批/尝试/回执与持久提醒、unknown 核查、lease/fence | 本轮创建，HTTP sink/假时钟验证 |
| [src/main/capabilities/](src/main/capabilities/) | 受审核 Provider/Broker/Recipe、既有适配与扩展 Ports | 本轮创建，陌生/恶意扩展验证 |
| [src/main/testBoundary.ts](src/main/testBoundary.ts) | App 与 Store 的隔离测试目录校验 | 本轮创建 |
| [src/renderer/HarnessViews.tsx](src/renderer/HarnessViews.tsx) | 本轮范围、来源原文、条件理解、反馈、目标、回执与来源授权 | 本轮创建，实机合成操作/看图 |
| [src/renderer/harness.css](src/renderer/harness.css) | 上述状态的中性色、窄窗与可读性样式 | 本轮创建，浅深色复查 |
| [tests/harness/](tests/harness/) | 独立 fixtures、94 场景适配、协议/隐私/迁移/故障/扩展、heldout 语料与真实模型 runner | 本轮创建；脚本语义与真实模型分开 |
| [tests/harness/conversation-quality-corpus.json](tests/harness/conversation-quality-corpus.json) | 小朋友/长辈、情绪倾听、纠正、隐私草稿、一步选择和反工程复述的合成评估语料 | 本轮新增；不含真实用户资料 |
| [tests/trajectory-validation.test.mjs](tests/trajectory-validation.test.mjs) | 32 条人本协作开发轨迹的机制边界、not_run 层与 94 场景保留负控 | 本轮新增；不调用模型 |
| [tests/harness-ui.mjs](tests/harness-ui.mjs) | 原 Electron 中的记忆按需展开、范围、目标、回执、反馈与临时输入闭环 | 本轮创建；round22 已复核 |
| [scripts/assemble-visual-audit.mjs](scripts/assemble-visual-audit.mjs) | 汇总桌面、连接、地图与 Harness 截图/报告，逐页标记视觉审核状态 | 本轮创建；round22 已复核 |
| [scripts/test-environment.mjs](scripts/test-environment.mjs) | 每次新建隔离资料目录，清理外部源环境入口 | 本轮创建 |
| [scripts/test-harness.mjs](scripts/test-harness.mjs) | 编译、运行分层套件并由实际 TAP 生成报告 | 本轮创建 |
| [scripts/evaluate-harness.mjs](scripts/evaluate-harness.mjs) | 离线执行与显式测试密钥门控的真实评估 | 本轮创建 |
| [scripts/score-harness-evaluation.mjs](scripts/score-harness-evaluation.mjs) | 完整审核集的分母、区间、消融比较与安全门槛 | 本轮创建；统计机制测试 |
| [scripts/score-conversation-quality.mjs](scripts/score-conversation-quality.mjs) | 可观察的人类体验信号：前台/后台轮次、列表/元话语、重复、工具与活动规则过度具体化 | 本轮新增；启发式提示，不证明同理心 |
| [scripts/harness-evidence.mjs](scripts/harness-evidence.mjs) | 设计包清点、源码指纹及 INV/X/40组自动结果映射 | 本轮创建 |
| [scripts/verify-harness.mjs](scripts/verify-harness.mjs) | 统一机制/映射/模型配置/文档门禁 | 本轮创建 |
| [scripts/validate-trajectories.mjs](scripts/validate-trajectories.mjs) | 32 条开发轨迹的 schema/步骤/状态来源边界校验；生成 M 报告并明确 L/U not_run，不向模型传 gold | 本轮新增；不调用模型 |
| [scripts/harness-recover.ts](scripts/harness-recover.ts) | 预览优先、应用最新屏障、新目录恢复与失败隔离 | 本轮创建 |
| [scripts/harness-recover.mjs](scripts/harness-recover.mjs) | 编译并运行恢复工具，不覆盖默认用户目录 | 本轮创建 |
| [scripts/map-geometry.mjs](scripts/map-geometry.mjs) | 当前地图源几何验证；不生成路由连边 | 当前实现；已验证 |
| [scripts/record-map-v2.mjs](scripts/record-map-v2.mjs) | 当前地图正常速度录像工具；停止定位后录制 | 当前实现；可复现 |
| [scripts/build-harness-pdf.py](scripts/build-harness-pdf.py) | 既有 PDF 生成脚本，非 App 运行入口 | 清点；本轮未修改/执行 |
| [tests/map-v2-faults.mjs](tests/map-v2-faults.mjs) | 当前地图资源/渲染故障验证 | 当前实现；已运行 |
| [tests/map-v2-performance.mjs](tests/map-v2-performance.mjs) | 当前地图性能与触控采样 | 当前实现；已运行 |
| [tests/inspect-geometry.mjs](tests/inspect-geometry.mjs) | 隔离 Electron 窗口几何与输入字号观测；不读用户资料 | 当前实现；辅助检查 |
| [在场-Harness-设计与Codex实施包/](在场-Harness-设计与Codex实施包/) | 用户提供的 01–05、contracts、94 场景/200 问/traceability、研究来源与校验工具；保留原件 | 关键正文全读；逐文件指纹清点 |
| [在场-Harness-人本协作设计与Codex实施包/](在场-Harness-人本协作设计与Codex实施包/) | 用户提供的后续人本协作设计、实施提示与 acceptance 轨迹；作为未来实施规范保留，不自动覆盖当前验收结论 | 已归档；不作为本次界面请求的运行指令 |
| [在场-Harness-理解与行动-设计实施包.zip](在场-Harness-理解与行动-设计实施包.zip) | 当前设计包的原始压缩归档，保留原件 | 清点，不执行其中历史命令 |
| [UNDERSTANDING-ACTION-IMPLEMENTATION.md](UNDERSTANDING-ACTION-IMPLEMENTATION.md) | 当前理解与行动任务的阶段、后端门槛、实际验证和待办；不替代本导航 | 后端离线通过，真实重复被余额阻塞；前端未开始 |
| [runtime/hermes/](runtime/hermes/) | 固定上游版本声明及私有 stdio 侧车；真实 AIAgent，宿主管理全部传输与工具出口 | 已接生产 Harness；真实协议/委派有界验证，8项引擎机制通过 |
| [src/main/runtime/hermes.ts](src/main/runtime/hermes.ts) | 侧车帧边界、运行归属、版本、取消、模型和工具宿主回调 | 本次引擎机制8/8，源码已用于可搬移资源 |
| [scripts/setup-hermes.mjs](scripts/setup-hermes.mjs) | 固定源码/依赖安装与窄适配，拒绝覆盖不同上游版本 | 本次已执行 |
| [scripts/stage-hermes-runtime.mjs](scripts/stage-hermes-runtime.mjs) | 复制已锁定的Python/Hermes及依赖为可搬移资源，验证包内解释器；生成打包配置 | 可搬移引擎8/8，Electron成品仍待验收 |
| [src/shared/calendar.ts](src/shared/calendar.ts) | 本地时间对象、重复和单次变更的共用schema | 后端机制已运行 |
| [scripts/live-acceptance-eval.ts](scripts/live-acceptance-eval.ts) | 既有真实验收入口源码 | 历史测试工具，保留 |
| [scripts/judge-live-acceptance.ts](scripts/judge-live-acceptance.ts) | 既有模型评估器 | 历史测试工具，保留 |
| [scripts/run-live-acceptance-eval.mjs](scripts/run-live-acceptance-eval.mjs) | 编译并启动既有真实验收 | 已定位，当前40故事另有入口 |
| [scripts/run-judge-live-acceptance.mjs](scripts/run-judge-live-acceptance.mjs) | 编译并启动既有评估器 | 已定位，当前不执行 |
| [scripts/live-zju-deepseek-eval.ts](scripts/live-zju-deepseek-eval.ts) | 既有校园账户与模型评估源码 | 当前未读取真实学生数据 |
| [scripts/live-zju-deepseek-smoke.ts](scripts/live-zju-deepseek-smoke.ts) | 既有校园账户与模型探针 | 当前未运行 |
| [scripts/run-live-zju-deepseek-eval.mjs](scripts/run-live-zju-deepseek-eval.mjs) | 校园真实评估编译入口 | 当前未运行 |
| [scripts/run-live-zju-smoke.mjs](scripts/run-live-zju-smoke.mjs) | 校园真实探针编译入口 | 当前未运行 |
| [scripts/verify-zju-account.ts](scripts/verify-zju-account.ts) | 既有校园账户验证脚本 | 不作为本次合成测试数据来源 |
| [tmp-live.cjs](tmp-live.cjs) | 既有临时探针 | 保留，非生产入口，未执行 |
| [tmp-meta.json](tmp-meta.json) | 既有临时元信息 | 保留，非运行配置 |
| [tmp-print-argv.cmd](tmp-print-argv.cmd) | 既有参数传递探针 | 保留，未执行 |
| [tmp-print-argv.mjs](tmp-print-argv.mjs) | 既有参数传递探针 | 保留，未执行 |
| [tmp-probe.cjs](tmp-probe.cjs) | 既有编译探针 | 保留，未执行 |
| [tmp-probe.ts](tmp-probe.ts) | 既有探针源码 | 保留，未执行 |
| [scripts/understanding-baseline.mjs](scripts/understanding-baseline.mjs) | 保存当前源码/资料的独立基线与哈希，不复制个人运行库 | 本次已执行，205 文件 |
| [在场-Harness-理解与行动-设计实施包/](在场-Harness-理解与行动-设计实施包/) | 当前任务 00–04 的完整规格与公开 40 故事 | 正文全读，作为当前任务依据 |
| [在场-Harness-审查研究与语义重构包/](在场-Harness-审查研究与语义重构包/) | Hermes 前置选型、批判、历史源码探针与研究；保留背景证据 | 关键选型/入口已读，历史结果不算本次实测 |
| [在场-手机驻留式演进-v2-研究与Codex实施包/](在场-手机驻留式演进-v2-研究与Codex实施包/) | 手机演进与 72 项未来轨迹；保留现有 React/地图资产约束 | 入口清点；不把本次桌面任务扩成手机移植 |
| [tsconfig.harness-tests.json](tsconfig.harness-tests.json) | 新增理解/行动、真实评估与引擎测试的严格类型检查 | check:harness 已执行 |
| [scripts/run-understanding-comparison.mjs](scripts/run-understanding-comparison.mjs) | 同任务B0–B3真实模型对照；B1映射到经哈希核对的旧源码快照 | 六个共同任务已运行，结果分组记录 |
| [scripts/run-understanding-ablations.mjs](scripts/run-understanding-ablations.mjs) | 四项机制的合成消融与故障注入，保留所有关闭分支失败；不关闭隐私或实际权限 | 两轮有界实测，不作自然模型质量结论 |
| [scripts/summarize-understanding-evaluation.mjs](scripts/summarize-understanding-evaluation.mjs) | 只读汇总已有模型/消融/费用证据，明确任务未完成和外部阻塞 | 已生成当前报告 |
| [tests/understanding-report.test.mjs](tests/understanding-report.test.mjs) | 分母、未判分、故事族重复和空数据区间的报告回归 | 2/2通过，不调用模型 |
| [scripts/check-deepseek-balance.mjs](scripts/check-deepseek-balance.mjs) | 通过官网只读余额接口检查API可用性，仅保存布尔状态，不输出Key或余额金额，不调用生成模型 | 已确认恢复可用 |
| [scripts/audit-understanding-run.mjs](scripts/audit-understanding-run.mjs) | 逐项审计60故事三次重复、缺失/重复/未判分记录和固定规格阈值；不认证产品完成 | 新增审计回归3/3 |
| [tests/understanding-audit.test.mjs](tests/understanding-audit.test.mjs) | 防止缺失证据、重复选择或真值问题被总通过率掩盖 | 3/3 |
<!-- owned-file-index:end -->
### 归组目录

`.runtime/` 为锁定的上游源码、隔离依赖与静态配置，不是用户数据；`build/` 为图标及生成的 `runtime-staging-*` 运行包，运行包按 manifest/uv.lock 核验，不纳入自有源码字节指纹；`licenses/` 为许可；`artifacts/harness/` 为本轮源码/命令/逐例结果/隔离目录/截图及模型 not_run；`artifacts/map-v2/` 为地图既有和本轮回归；`artifacts/review/` 为历次与当前桌面/连接/成品证据；`artifacts/documentation/` 为文档和历史宿主发现结果。`dist/`、`dist-electron/`、`release/` 是构建产物；`node_modules/` 为依赖；`.git/` 无提交；`.test-data/` 只使用本轮新建的隔离子目录，不作为公开源码或真实学生资料。`output/pdf/` 与 `tmp/pdfs/` 是工作区现有 PDF 产物和临时目录，本轮只确认目录类型，未读取或改写内容。

<a id="verification"></a>
## 运行、报告与维护

从 [README](README.md#开发与验证) 或 [实施说明](HARNESS-IMPLEMENTATION.md#可复现验收) 运行命令。`verify:harness` 不把 live 的 `not_run` 算作真实语义成功；本轮已留存独立的 live 目录，但仍需独立审核；桌面、地图和成品独立验收。94 场景由 runner 执行后检查，失败不 skip；`harness-evidence.mjs` 自动生成 20 项 INV、16 项 X 和 40 组映射及逐文件校验。

真实模型需要显式测试授权与单独 Key；本轮已在该边界内完成 24 条 heldout×3、12 条人类体验轨迹，以及官网 `deepseek-flash` 图文规则/日常提醒直连探针和真实 Electron 图文全链。这些是有界运行证据；原文槽位、人类体验标签和通用视觉正确率仍需独立审核。真实校园、天气、位置和写服务也分别记录授权/实际结果，不用 mock 替代。

三个项目 Skill 仍位于 `.agents/skills/`，AGENTS 保留简短路由。前轮 Codex CLI 发现和交接记录在 [历史验证记录](artifacts/documentation/HANDOFF-VALIDATION.md)，本轮未重新运行宿主发现。没有安装新的技能或调用开发子代理。

新增、删除、移动文件或改变职责时同次维护本索引、A/B 状态和证据。`node scripts/check-project-docs.mjs --report` 校验本地引用、索引与应用字节指纹；它不访问账户、不证明行为正确。旧报告不能自动验证新源码，最终应用指纹必须对应实际运行过的版本。







## 本次责任到实现的简明映射

| 责任 | 代码事实所有者 | 当前证据 / 限制 |
| --- | --- | --- |
| 真实单循环与独立委派 | `src/main/harness.ts`、`runtime/hermes/sidecar.py`、`runtime/hermes.ts` | 固定AIAgent和原生delegate；8项引擎机制，真实两worker曾取证并消费。新最小来源约束需再做真实复测 |
| 原话、收缩、用途、临时与禁传 | `runtime/turn-controls.ts`、`policy.ts`、`read-purpose.ts` | 读取/保存之前执行；本机禁传先于控制模型；不从助手工作者指令签发用途 |
| 共同理解、明确请求、收尾 | `runtime/collaboration.ts`、`completion-review.ts`、Repository | 请求按会话在SQL筛选；无工具调用的已有请求和调用期间状态变化也进入核查；假完成故障3/3被开启的收尾机制修复 |
| 原文、条件、后台与遗忘 | `runtime/context.ts`、`memory/`、`storage/repository.ts` | 三层按需供给、未索引原文兜底、连续水位、版本与遗忘屏障；原文与推理协议不混存 |
| 日程、执行与撤销 | `actions/calendar.ts`、`local-calendar.ts`、`runtime.ts` | 事件/待办/提醒分开；时区、重复例外、未知时长、事务回执、版本保护与补偿；受控故障通过 |
| 有界运行与诚实失败 | `provider.ts`、`runtime/structured-result.ts`、`model-usage.ts` | thinking保持开启；结构格式重试有界；不把内部错误假说成网络错误；评测quota会停止批次 |
| 交付与回退 | `setup-hermes`、`stage-hermes-runtime`、Repository迁移/恢复 | 固定上游锁、窄适配hash、Git跟踪文件打包；数据库版本5；旧备份恢复仍先应用最新屏障 |

本次最后的验证记录仍区分离线机制、真实模型、真实UI与成品。新前端、独立人评、真正盲测、未连接外部服务均未冒称完成。当前阻塞是DeepSeek官方余额，而不是缺少已授权Key。

当前源码字节指纹于2026-09-13按已完成的离线构建/类型/机制验证更新；这只锁定本次工作区，不把缺失的真实重复、前端或成品体验验收改为通过。

2026-09-13续接修复：协作事项改为数据库先筛选后分页，跨越200条记录后仍可恢复旧事项、选项和修复引用；已知ID更新使用同一权限过滤后的单条读取。新增分页回归2/2、状态10/10与理解20/20通过。来源控制提案的“存在限制依据但映射为空”现进入有界修复，不按无限制处理；该项正在重跑真实控制集。

本次分页/来源一致性更新后的离线回归为220/220，真实180次重复仍在运行；此指纹不代表模型总门槛或前端已验收。
