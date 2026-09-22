# 从哪里添加功能

路径保持原仓库结构；具体职责索引仍以 [PROJECT-NAVIGATION](../PROJECT-NAVIGATION.md) 为入口，旧状态文字要与 04 的冲突说明一起读。下面列的是后续开发建议，本交接任务没有执行产品变更或真实账户命令。

| 任务 | UI/入口 | 契约与宿主实现 | 应检查/运行 |
|---|---|---|---|
| 修改聊天或页面 | `src/renderer/App.tsx`、`SettingsPanel.tsx`、`HarnessViews.tsx`、相应 CSS | `src/shared/types.ts`、`schemas.ts`；新增 Bridge 时同时改 `main/preload.ts` 与 `main/main.ts` | build、core、相应 Electron desktop/connection/harness-ui；真实截图查看、窄窗/焦点/退出；先遵守项目后端阶段门槛 |
| 新增只读能力 | 工具目录通过 `look_up` 发现，不给主循环加名称特例 | `main/capabilities/broker.ts` 的 manifest/schema；`builtin.ts` 注册；`main/tools.ts`/`runtime/coordinator.ts` 绑定 | extensions、ports、scenarios；验证陌生名称、空/过期/部分数据、未授权、取消、实际来源消费 |
| 新增本地可撤销动作 | 现有动作卡/我的安排 | `shared/harness.ts`、`shared/calendar.ts`；`actions/runtime.ts`、`local-calendar.ts`、Repository | state、faults、calendar、retention-effects；真实事务、重复确认、未知结果、版本冲突、重启/撤销 |
| 接外部服务 | 沿现有连接设置，不默认加入账户扫描 | Broker/Ports、单独 adapter；如 `main/zjuAdapter.ts` 的受限目录/子进程边界 | 未连接和权限失败先测；先用隔离 HTTP sink，再由使用者明确授权真实测试；不把查询升级为写入 |
| 改记忆或上下文 | 记忆详情、纠正/删除/来源 | `memory/service.ts`、`memory/model.ts`、`runtime/context.ts`、`collaboration.ts`、`policy.ts`、`storage/repository.ts` | understanding、privacy、controls、collaboration-paging、long-input-review；旧原文、水位、删除屏障、范围缩小与不适用记忆 |
| 改地图或定位 | `renderer/map/` | `shared/map-v2.ts`、`shared/map-routing.ts`；`main/mapService.ts`、`mapLocation.ts`；assets/public map-v2 | map:core、map Electron；核对所有候选入口、真实边/单位、不可达、定位误差、旧响应失效 |
| 增加模型传输 | 宿主 `main/model-selection.ts`，不允许 renderer 任意改提供方 | `main/provider.ts` 的 complete/assistantMessage/metadata；参照 `luna-provider.ts`；Hermes `modelIdentity` | provider/protocol、luna 机制、主/子/记忆/压缩/成稿所有出口、scope 清链、native 图像、取消、用量；实测身份与生产默认分开 |
| 增加测试或验收场景 | `tests/harness/` 和相应脚本 | `support.ts` 隔离 Fixture；`understanding-cases.ts`、scoring/audit 与实际环境终态 | check:harness、对应 suite；gold 不给被测模型；开发集不称盲测；评分器误判也保留原轨迹和独立复判 |

常用机制定位：`node scripts/test-harness.mjs --suite <套件名> --layer backend --report-dir <新报告目录>`。无密钥本地验证与真实模型验证必须分开，真实模型不属于“跑一下所有测试”的默认动作。历史 B1 对照需要原始冻结快照；本包不携带那份重复源码，不能用现在的源码冒充旧 B1。
