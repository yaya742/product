# 功能全景

以下“接入”指源码调用关系；历史运行证据不自动代表本次快照已验证。新解压验证统一见 VERIFICATION，模型历史统计见 EVIDENCE-SUMMARY.json。

| 能力 | 用户入口 | 主要源码（相对 src/） | 状态 | 实际证据 | 已知限制 |
|---|---|---|---|---|---|
| 对话与当前请求 | 聊天、停止、重试、历史 | renderer/App.tsx；main/harness.ts；main/runtime/collaboration.ts | 已接入当前运行路径 | 原 IPC 与 Hermes 调用；历史 Luna 180 次完整开发批次 | 159/180 通过，21 条未通过记录不能平均成全部可靠；简单对话与复杂收尾有不同路径 |
| 图文输入 | 原“＋”上传菜单、发送后缩略图 | main/main.ts、preload.ts、provider.ts；shared/limits.ts | 已接入当前运行路径 | 历史 DeepSeek、Luna 各有真实 Electron 图文报告：1 文本段＋1 JPEG | 8 MB 原图、1600 px 最长边、去 EXIF；不先转写、不进文字记忆；不等于任意 OCR 均正确 |
| 资料范围、来源、隐私 | 本轮范围、来源详情、删除 | main/runtime/policy.ts、turn-controls.ts、context.ts；storage/repository.ts | 已实现但有限制 | 确定性来源/撤权/删除测试；S40 范围变化实测 | 逻辑隔离不是多租户认证或 OS 沙箱；本地禁传没有可替代的离线模型 |
| 可纠正记忆与遗忘 | 连接与偏好中的记忆、改正/停用/删除 | main/memory/model.ts、service.ts；storage/repository.ts | 已实现但有限制 | 条件、版本、引用、水位、删除屏障测试；真实限时例外样本 | SQLite 正文未整体加密；不保证擦除 SSD 历史块或已导出/已发送的外部副本 |
| 目标与持续事项 | 安排、目标采用/暂停/取消 | main/runtime/work.ts、collaboration.ts；renderer/HarnessViews.tsx | 已实现但有限制 | Work/World/Request 独立状态及机制测试 | 最新 Luna 冻结批次仍有 S35 取消目标失败；新资源不等于重新授权 |
| 本地日历、提醒、撤销、未知 | 我的安排、动作卡、撤销/核查 | main/actions/runtime.ts、calendar.ts、local-calendar.ts、reminders.ts | 已实现但有限制 | 事务、回执、幂等、重启、单次重复例外等机制 | 未知时长不补一小时；应用关闭不保证提醒；本地完成不等于校方计次或外部送达 |
| 对外草稿 | 对话请求草稿、宿主交付正文 | main/runtime/release-projection.ts、release-composer.ts、release-store.ts | 已实现但有限制 | 独立投影/写作/核验/版本、来源删除链；S21 等真实样本 | 默认只生成稿件，没有真实邮件/群聊发送连接；最新批次仍有混合稿件任务失败 |
| 校园本地导入 | 连接与偏好→校园资料 | main/zjuAdapter.ts；storage/domains.ts；capabilities/builtin.ts | 已接入当前运行路径 | 合成 example 与按域/来源/学期合并测试 | 本地快照不是实时账号；部分空结果不能推成全校无数据 |
| 校园账户读取器 | 校园连接器设置 | main/zjuAdapter.ts；shared/types.ts | 外部依赖未随包提供 | 受限子进程契约与合成读取器测试 | 外部 zju-student-info 源码、GPL 许可安装及凭据由使用者另行提供；本次未读真实账户 |
| 地图与系统位置 | 顶部地图、路线卡、定位按钮 | renderer/map/；main/mapService.ts、mapLocation.ts；shared/map-routing.ts | 已实现但有限制 | 本地 OSM 数据、22 项核心测试历史、Electron 地图测试 | 533 栋建筑、608 地点、25 栋可路由入口；未知入口不画直线；仅当前图最短，不保证实时门禁；手机位置未接入 |
| 天气 | 开启天气后按需查询 | main/capabilities/builtin.ts | 已接入当前运行路径 | Open-Meteo 只读适配器与受控测试 | 杭州城市参考预报，不是精确位置；本次没有联网天气验证 |
| 能力扩展与只读工作者 | 主模型按需发现和分派 | main/capabilities/broker.ts、ports.ts；runtime/hermes/sidecar.py | 已接入当前运行路径 | 固定原生委派；较新 S30 三次通过，真实独立请求/观察/消费 | 共享预算、只读来源子集和取消；不是任意插件安装入口，不启用 Codex 开发子代理 |
| DeepSeek 模型通道 | 连接与偏好、聊天 | main/provider.ts、model-selection.ts | 已实现但有限制 | 官方端点固定 deepseek-flash；历史图文与开发批次 | 本次不读 Key、不查余额、不联网复验；历史 402 不能当作当前余额实测 |
| GPT‑5.6‑Luna 模型通道 | 仅宿主代测启动命令 | main/luna-provider.ts；scripts/run-luna-test.mjs | 仅合成或测试 | 真实 App Server 代测与原 Harness 路径、独立模型身份 | 临时代测品；不是生产默认；服务端输出 token 上限不支持，完成后宿主拒收超限；费用未知，旧 UI 标签仍写 DeepSeek |
| 外部发送、预约、同步 | 当前只有契约/受控准备与测试入口 | main/capabilities/ports.ts、actions/runtime.ts | 仅合成或测试 | 隔离 HTTP sink、未知回执/核查/撤销契约 | 不随包提供真实写服务，不能把接口存在说成已发送/已预约 |
| 手机驻留、多设备与语音等 | 尚无完整当前用户入口 | 历史研究设计；现有可扩展 Ports | 未来设计 | 设计资料与部分接口 | 无实际手机后台、跨设备服务、语音采集、PDF/压缩包通用解析交付 |
