# 十分钟认识在场

在场面向处理校园事务和日常安排的学生：在一个对话框里查询资料、澄清问题、管理可纠正的理解，并办理明确授权的本地事项。它不应该把每次聊天都变成生活管理，也不能用一句“完成了”代替回执。

**本次干净验证未通过**：核心与Hermes集成测试有失败，详见验证记录。

这是 **0.3.0 当前工作树源码快照**，包含未提交与未跟踪源码，不是正式发布版。Git 只有一条提交，单靠 HEAD 无法还原此包。验证结果和未闭合问题见 [04](04-CURRENT-STATUS-AND-LIMITS.md) 与 [VERIFICATION](VERIFICATION.md)。

## 安装与启动

使用 Windows、Node.js 24+、Git 和 uv。建议解压到较短路径；过深路径可能使 Git 无法检出 Hermes。不要复制别人的数据库、模型 Key 或登录目录。

```powershell
npm ci
npm run setup:hermes
npm run build
npm run dev
```

无密钥可以先看本地示例；示例回复不是模型能力证据。Hermes 安装会联网下载固定源码及 Python 依赖，不使用校园账户。生产模型默认是 **DeepSeek deepseek-flash**；**GPT‑5.6‑Luna 是临时代测品**，依赖同学自己的 App Server 登录环境，包内没有认证信息。首次交接验证不运行真实模型测试。

## 架构与阅读顺序

React 经 preload/受信 IPC 进入 Electron 宿主；宿主掌握身份、范围、数据、工具和行动回执，固定 Hermes 负责模型—工具—观察循环。模型只提出判断和调用，不拥有权限或业务事实。

按顺序读本页 → [功能全景](01-FEATURE-PANORAMA.md) → [架构与归属](02-ARCHITECTURE-AND-OWNERSHIP.md) → [添加功能](03-WHERE-TO-ADD-FEATURES.md) → 状态与验证。再沿根目录 [PROJECT-NAVIGATION](../PROJECT-NAVIGATION.md) 定位源码；旧文档中的“当前”和命令有历史语境，不要直接执行旧实施目标。

改页面从 `src/renderer` 进入；加只读能力从 `capabilities/broker.ts` 和 `builtin.ts` 进入；加本地动作先看 `actions/runtime.ts`；改地图看 `mapService.ts` 与 `shared/map-routing.ts`。先明确事实所有者，再扩展共享契约和测试。当前后端仍有真实模型失败，前端新阶段尚未完成；本交接任务没有继续修复或重新设计产品。
