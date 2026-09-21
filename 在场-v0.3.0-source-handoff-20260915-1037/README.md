# 在场 PC Agent 核心源码

这是 Windows Electron 桌面 Agent 的核心源码，包含 React renderer、Electron IPC、SQLite 本地存储、Harness、记忆、对话、插件管理和本地安排能力。

本分支明确不包含：

- 校园信息、校园账号、校园资料导入与连接器；
- 天气及定位相关 Provider；
- 地图、地图资源、路线和位置服务；
- Android/Capacitor 移动端。

根目录的 `zaichang/`（如果出现在其他工作区）是本机运行数据、缓存和 SQLite 资料，不是源码，本分支不会上传它。

## 开发与验证

需要 Node.js、Git 和 Windows Electron 开发环境：

```powershell
npm ci
npm run build
npm test
```

`npm run build` 执行 TypeScript、Vite 和 Electron bundle 构建；`npm test` 只运行 PC Agent 核心冒烟测试。真实账户、外部网络服务和真实设备验收不属于本分支验证范围。
