# 在场（Zaichang）

在场是一个以 Agent + Plugins 为核心的本地优先校园助手。本仓库按功能组织源码；生成物、运行时数据、发布包和本地凭据不属于源码。

## 源码目录

- `agent/`：Electron/React 桌面 Agent、Agent Runtime、插件宿主和平台适配。
- `mobile/`：React/Vite + Capacitor 移动端，手机本地运行并直接调用用户配置的 DeepSeek API。
- `weather/`：Python/FastAPI 天气服务、天气包及其测试。
- `map/`：地图能力的统一入口、职责清单和跨端边界；平台 UI 与设备适配保留在 `agent/` 和 `mobile/`。
- `school/`：浙江大学校园信息插件和只读连接器。

目录与分支边界详见 [REPOSITORY_LAYOUT.md](REPOSITORY_LAYOUT.md)。产品范围、数据边界和阶段规划详见 [PRODUCT_PLAN.md](PRODUCT_PLAN.md)。

## 开发入口

桌面端：

```powershell
cd agent
npm ci
npm run build
npm test
```

移动端：

```powershell
cd mobile
npm ci
npm run build
npm run cap:sync
```

天气服务：

```powershell
cd weather
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
pytest
```

更完整的启动、打包和验收说明分别位于 [Agent 说明](agent/README.md)、[移动端说明](mobile/README.md)、[天气说明](weather/README.md)、[地图说明](map/README.md)和[学校插件说明](school/README.md)。

## 提交边界

- 不提交 `node_modules`、`dist`、`release`、`artifacts`、APK、缓存、运行时数据库或本地凭据。
- 新功能分别进入 `codex/agent`、`codex/mobile`、`codex/weather`、`codex/map`、`codex/school` 责任分支；跨端组合功能进入 `codex/integration-*`。
- 所有功能分支都以 `main` 为祖先并保留根级 `AGENTS.md`；`main` 更新规则后，功能分支必须及时合并。
- 构建通过只代表构建门槛通过；真实账号、真实设备、校园网络和通知行为需要单独验收。
- 提交前检查 `git status --short` 和 `git diff --cached --name-status`，不要用未经审查的 `git add .`。
