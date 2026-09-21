# PC Agent 开发说明

- 接手未知变更时先阅读 [PROJECT-NAVIGATION.md](PROJECT-NAVIGATION.md) 和 `.agents/skills/project-navigation/SKILL.md`。
- 只把 Electron/React 桌面 Agent 核心实现放在本分支；校园信息、天气、地图/定位和移动端不属于当前范围。
- 修改 IPC、共享类型、权限策略、数据保留或插件协议时，同时检查调用链、Renderer 类型和本地测试。
- 不读取或提交运行数据、SQLite 数据库、缓存、密钥、`node_modules`、`dist`、`release` 或其他本机产物。
- 修改完成后至少运行 `npm run build`、`npm test` 和 `npm run check:docs`；不能把本地检查描述为真实模型、账号、外部服务或设备验收。
- 所有代码注释和变量名保持英文；面向用户的说明使用中文。
