# 在场

帮助在校学生理清校园事务与眼前的下一步。当前版本为 **0.3.0**，使用 Electron、React、SQLite 与 DeepSeek，提供 Windows 桌面程序。

当前工作区正在接入理解与行动型 Harness，**尚未交付完成**。生产主循环已使用固定版本 Hermes。DeepSeek 再次返回余额不足后，按用户要求接入 **App Server 的 GPT‑5.6‑Luna 临时代测**；生产默认仍保留 DeepSeek。替换边界、命令及无法完全等价的协议限制见 [代测说明](LUNA-TEST-SUBSTITUTE.md)。两个前端设计技能和本次 UI 总验收尚未开始。`release/` 中既有成品是历史版本，不能作为新源码已完成的证据。

## 在场的简洁原则

在场不是一个让用户审查模型流程的控制台。它的承诺是：你用自然话说出眼前的事，系统承担整理，你先看到最重要的结果和下一步。

- 每个页面只突出一个问题和一个主要动作；其他信息按需展开。
- 不把“正在使用、待确认、原文依据、尚未核验”等工程分类堆在用户面前。用户只先看到“现在会影响回答什么”；来源、条件和核验可在需要时查看。
- 建议、已登记、已执行和未知结果用不同的自然语言表达；错误、撤销和恢复入口贴近发生的位置。
- 动效用于解释变化、保持连续和反馈因果，必须及时、可打断并尊重减少动态效果；不为制造“高级感”强迫等待。
- 面向第一次使用、低技术熟练度和注意力有限的人设计；不要求先学习内部术语，不把“更多说明”当作简洁的替代品。

视觉取舍参考 Apple 等平台对直接操作、层级、材料和动效的通用经验，但不复制某个品牌皮肤，也不把具体像素、圆角或颜色当成原则。当前页面的设计证据和限制见 [DESIGN](DESIGN.md#method-evidence)。

启动 `release/win-unpacked/在场.exe` 时保持同目录运行文件完整；便携版本为 `release/Zaichang-0.3.0-Windows.exe`。没有密钥时运行明确标注的本地示例。历史版本曾运行 24 条跨情境与 12 条体验场景的模型测试，但没有独立人评、seed 或满意度证据；不能把这批样本写成“已经更懂用户”。

从原输入框说出需要帮助的事。“本轮范围”可选择只用本条与附件、不形成长期理解，或本轮不保存；也可以直接在对话里说明。回复旁可展开实际来源与查询状态。连接与偏好中的“记忆”页先显示会帮到当前对话的内容；其他待确认、停用或待整理的内容按需展开，并可改正、停用或删除。旧建议的依据改变后需要重新核对。

原输入框的“＋”菜单可选一张 JPG、PNG 或 WebP 图片，再与当前文字一起发送。图片会在本机缩放并转成不带 EXIF 的 JPEG；发出后只显示紧凑缩略图，用户点击后才打开大图预览。图片与文字在同一条模型消息中联合理解，不先生成描述或向量中间层。

“我的安排”保留已确认的本地安排，以及需要决定的目标和待核查回执。建议不等于已执行，本地完成不等于校方计次。临时模式不保存对话、附件或新安排；经过核对，撤销既有操作和删除已有理解仍可生效。关闭应用不保证提醒，提交系统通知也不等于送达或已读。

同一条话可以同时包含倾听和明确的小动作；在参数充分、属于本人现实范围且可撤销的本地登记上，宿主可以直接写入并返回真实本地回执与撤销入口。外部发送、预约、费用或不可逆操作仍保留具体授权与回执核查。跨会话事项会保留有限的共同语境与稳定选项锚点，后台长期记忆整理不会阻塞首个有意义的回复。

右上角校园地图图标打开当前二维校园地图；对话的路线卡进入同一组件。拖动平移、滚轮缩放、Shift + 拖动旋转；两点路线先选 A 再选 B。返回后对话和草稿保留。地图覆盖紫金港与望月公寓周边，533 栋建筑和求是大道、西操场、东操场、中心湖、启真湖等核心地标可检索；25 栋建筑具有已记录的步行入口连接；未知入口不生成假路线。数据来自 OpenStreetMap，求是大道名称位置以当前浙大公开 WFS 交叉核验，不是实时门禁保证；Windows 本机位置与手机同步是不同能力。详见 [地图 V2](MAP-V2.md)。

## 资料与连接

在“连接与偏好”中填写 DeepSeek 密钥并连接。API Key 由 Electron safeStorage 在 Windows 上加密保管，renderer 只能得到是否已保存。聊天数据库暂未整体加密；连接模型时只发送本轮允许使用的资料。可以导出或清空本地资料。删除会清理本机相关来源和派生链，但不撤回外部导出、已发送的模型请求或已发生的外部动作；旧备份恢复必须应用最新删除屏障。

本项目开发和后续 agent 共用的 DeepSeek 凭据保存在仓库外，由当前 Windows 用户的 DPAPI 加密。`npm run deepseek:check` 只检查是否可用，不显示 Key；`npm run deepseek:run -- <command> [args...]` 只向该命令的进程树临时注入。带真实模型启动桌面开发版可用 `npm run dev:deepseek`，已授权的真实评估可用 `npm run eval:harness:live:project`（仅该专用入口开启 live 评估门禁）。不要对不受信的脚本使用该包装器。

校园连接器只使用设置中选择的外部读取器目录或显式配置路径，不扫描其他项目。账号密码由外部读取器保管，不放进模型或 renderer。校园资料按领域、来源、学校和学期合并；部分同步不清空其他领域。模型通过 `look_up` 按需读取。天气不是宿主内置能力，安装 `weather` 插件后才可查询；插件默认停用，城市参考预报不代表精确位置。

在“连接与偏好 → 接口”中可以直接安装第三方插件 ZIP，也可以为已安装插件选择升级或卸载。操作完成后只需关闭并重新打开在场；插件代码在独立进程运行，默认停用，权限和出站域名仍由宿主检查。插件包格式和入口约定见 [第三方插件包规范](PLUGIN-SDK.md)。

仓库自带天气插件示例。开发时运行 `npm run package:weather` 生成 `artifacts/weather-plugin.zip`，然后在设置页安装并启用；生产环境不会把天气能力偷偷作为内置 Provider 注册。

源码测试版可直接双击桌面的“在场（源码冷启动版）”快捷方式启动。该入口会在后台切换到源码目录、使用本机 Node.js 启动 Vite/Electron，并保留前端实时热更新；开发资料单独保存在 `%LOCALAPPDATA%\Zaichang\source-dev` 中，不会与已安装版抢占缓存，也不会被 Vite 纳入源码监听。如果默认端口被占用，会把实际端口传给 Electron。

图文输入已接入当前 DeepSeek 官网多模态模型；语音采集、PDF/压缩包解析、跨设备同步、学习/健康设备、邮件、钉钉及外部预约仍没有实际服务连接。独立模块材料与具体证据边界以 [项目导航](PROJECT-NAVIGATION.md#status) 为准。

给后续开发者的模型身份约定：当前调用 DeepSeek 官方 `https://api.deepseek.com/chat/completions`，请求模型 ID 固定为 `deepseek-flash`，截至 2026-09-13 官方对应 **DeepSeek-V4.1-Flash** 原生多模态模型。旧 `deepseek-v4-flash` 只是已退役 V4 的兼容名，不是本项目的请求 ID。完整调用契约和复现命令见 [AGENTS](AGENTS.md#当前官网调用契约2026-09-13-核对)。

## 开发与验证

源码开发需要 Node.js 24+、Git 与 uv；Hermes 安装器固定 Python 3.13 和上游依赖锁。后续成品将带上独立 Python/Hermes 资源，不要求用户另装开发环境。依赖按锁文件安装；先读 [AGENTS](AGENTS.md) 与 [项目导航](PROJECT-NAVIGATION.md)。

```powershell
npm ci
npm run setup:hermes
npm run dev
```

`dev` 是日常开发入口，默认可以使用本机资料。验收入口统一建立新的隔离目录：

```powershell
npm run build
npm test
npm run verify:harness
npm run test:harness:desktop
npm run test:desktop
npm run test:connection
npm run test:multimodal
npm run test:deepseek:vision
npm run test:multimodal:live
npm run test:harness:trajectories
npm run test:map:core
npm run test:map
npm run package
node tests/package.mjs
npm run package:weather
```

离线报告包含真实 SQLite、故障注入、HTTP sink 与设计包 94 个场景的执行结果；`test:harness:trajectories` 只做 32 条新增开发轨迹的机制边界校验，不把 gold 传给模型，也不冒充语义/体验通过。真实模型评估需要单独授权和测试密钥，缺配置写 `not_run`；已完成的有界样本与“像不像在照顾人”的逐条复核见 `artifacts/harness/conversation-quality-final/HUMAN-REVIEW.md`，不会借用生产密钥。完整命令、四类证据、迁移与预览恢复方法见 [Harness 实施说明](HARNESS-IMPLEMENTATION.md)。构建与测试不会执行真实外部预约或发送消息。

运行时提示词在 `prompts/`，开发 Skills 只提供方法，不能提升实际数据权限。职责与文件索引只维护在项目导航，设计判断与截图证据见 [DESIGN](DESIGN.md#harness-design)。


## 当前理解与行动任务的验证入口

```powershell
npm run check:harness
node scripts/test-harness.mjs --suite all --layer backend --report-dir artifacts/understanding-action/backend-check
npm test
npm run eval:harness:live:project -- --understanding-stories
npm run eval:harness:live:project -- --understanding-comparison
npm run eval:harness:live:project -- --understanding-ablations
```

`--layer backend` 明确将两项需要真实桌面交互的旧场景留给前端阶段；不能据此宣称 Electron 已验收。旧词面语义标签断言已逐项记录迁移为原话/权限边界检查，真实语义由公开与新增故事单独评估。真实批次使用项目已授权 DPAPI Key，不需要另交 Key；发生 quota/authentication 错误即停止新请求。

`ZAICHANG_STORY_SET` 可选 `public`（默认）、`supplemental`、`all` 或 `variants`；`ZAICHANG_STORY_FILTER` 是案例 ID 逗号列表，`ZAICHANG_STORY_REPEATS` 设置重复次数，`ZAICHANG_EVAL_REPORT` 指定新报告目录。不要覆盖失败记录或把不同源码版本拼成最新版本全量通过。
