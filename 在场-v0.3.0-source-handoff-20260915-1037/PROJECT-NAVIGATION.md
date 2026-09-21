# PC Agent 项目导航

<!-- app-baseline-sha256: ea70fa71e630c73211b98da54cedd2a81105f41ef05f8655ef414fc9e7f53d63 -->

## 当前范围

本目录是 Windows Electron 桌面 Agent 核心源码。当前分支只保留本地对话、记忆、历史证据、本地安排、权限策略、插件管理和可恢复动作链路。校园资料、天气、地图/定位和移动端不属于本分支。

## 关键入口

| 责任 | 入口 |
| --- | --- |
| Electron 主进程与 IPC | `src/main/main.ts`、`src/main/preload.ts` |
| Agent/Harness 主循环 | `src/main/harness.ts` |
| 运行时协调、工具与权限 | `src/main/runtime/coordinator.ts`、`src/main/tools.ts`、`src/main/runtime/policy.ts` |
| 本地存储与领域服务 | `src/main/store.ts`、`src/main/storage/` |
| 本地安排与提醒 | `src/main/actions/` |
| Renderer 页面 | `src/renderer/App.tsx`、`src/renderer/SettingsPanel.tsx`、`src/renderer/HarnessViews.tsx` |
| 共享协议 | `src/shared/types.ts`、`src/shared/schemas.ts`、`src/shared/harness.ts` |
| 核心测试 | `tests/core.test.ts` |

## 变更边界

- 不把运行数据、缓存、SQLite 数据库、密钥或构建产物当作源码提交。
- 不添加校园、天气、地图、定位或 Android/Capacitor 功能到本分支。
- 修改 IPC、权限、数据保留或外部接口时，同时更新共享类型、Renderer 调用和测试。
- 真实账号、外部网络、真实设备和生产发布需要单独验收，不能由本地构建或冒烟测试代替。

## 验证

```powershell
npm ci
npm run build
npm test
node scripts/check-project-docs.mjs
```

构建与测试只证明当前源码的静态类型、打包链路和本地核心冒烟行为；不会声称真实模型、账号、外部服务或设备已验收。

<!-- owned-file-index:start -->
- [package.json](package.json)
- [package-lock.json](package-lock.json)
- [tsconfig.json](tsconfig.json)
- [vite.config.ts](vite.config.ts)
- [index.html](index.html)
- [.gitignore](.gitignore)
- [.prettierignore](.prettierignore)
- [.prettierrc.json](.prettierrc.json)
- [AGENTS.md](AGENTS.md)
- [PROJECT-NAVIGATION.md](PROJECT-NAVIGATION.md)
- [README.md](README.md)
- [PLUGIN-SDK.md](PLUGIN-SDK.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [CHANGELOG.md](CHANGELOG.md)
- [src/](src/)
- [scripts/](scripts/)
- [tests/](tests/)
- [prompts/](prompts/)
- [runtime/](runtime/)
- [.agents/skills/](.agents/skills/)
<!-- owned-file-index:end -->
