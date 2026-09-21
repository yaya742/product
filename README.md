# PC Agent 分支

本分支只保留 Windows 桌面 Agent 本体，源码位于
`在场-v0.3.0-source-handoff-20260915-1037/`，包含 Electron/React、DeepSeek、Hermes、SQLite、本地记忆、日程提醒、权限/Harness、插件通用框架和图文对话。

本分支明确不包含校园信息、天气、地图或定位功能，也不包含移动端客户端及其运行资料。

进入源码目录后安装依赖并执行核心检查：

```powershell
cd .\在场-v0.3.0-source-handoff-20260915-1037
npm ci
npm run build
npm test
```
