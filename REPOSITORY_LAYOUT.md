# 仓库目录与分支边界

## 目标

这个仓库采用“一个集成源码树 + 多条责任分支”的方式维护。源码目录表达产品模块，Git 分支表达变更责任；构建物和运行时数据不承担源码备份职责。

## 目录职责

- `agent/` → `codex/agent`：桌面 Electron/React、Agent Core、插件宿主和平台适配。
- `mobile/` → `codex/mobile`：Android/Capacitor 移动端及手机侧本地能力。
- `weather/` → `codex/weather`：天气服务、Python 包、配置示例和测试。
- `map/` → `codex/map`：地图能力入口、共享边界和跨端职责清单。桌面地图 UI、Electron 定位适配和移动端 UI 仍放在对应应用目录，避免平台代码倒灌到共享层。
- `school/` → `codex/school`：学校插件和校园只读连接器。

所有新责任分支都必须以 `main` 为祖先，并保留根级 `AGENTS.md`。AI 读取的是当前工作树中的规则文件，因此 `main` 的规则发生变化后，需要把 `main` 合并到各功能分支。旧的 `PCagent`、`mobile_app`、`weather`、`school`、`codex/zaichang-desktop` 分支暂时作为历史与回退来源，不删除、不强推。

`codex/workspace-layout` 是当前源码归位和目录迁移分支；跨功能验收使用 `codex/integration-*`，不把尚未验证的组合直接推入 `main`。

## 本地 worktree 约定

建议让每个长期责任分支拥有独立 worktree，并使用能够直接说明用途的目录名，例如：

- `zaichang-source`：集成候选和目录整理。
- `zaichang-agent-worktree`：Agent 责任线。
- `zaichang-mobile-worktree`：移动端责任线。
- `zaichang-weather-worktree`：天气责任线。
- `zaichang-map-worktree`：地图责任线。
- `zaichang-school-worktree`：学校插件责任线。
- 临时修复 worktree：完成合并或归档后再移除，不能把它当成长期发布目录。

不要在保存发布包、测试数据库或旧运行时的目录中直接切换到源码分支。需要提取旧修改时，先建立干净 worktree，再按文件审查和迁移。

## 生成物与本地数据

以下内容默认只存在于本机或 Release 资产中：

- Node/Python/Gradle 依赖和缓存：`node_modules/`、`.venv/`、`.gradle/`、`__pycache__/`。
- 构建结果：`dist/`、`dist-electron/`、Android `build/`、同步后的 Web 资源。
- 桌面发布和测试产物：`release*/`、`artifacts/`、`.test-data/`。
- 运行时数据：`.runtime/`、`.dev-data/`、数据库、日志和本地会话。
- 安装产物：APK、AAB、EXE、ZIP 和下载中的临时文件。
- 凭据：`.env`、DeepSeek Key、校园密码、Cookie、令牌和本地认证响应。

运行时目录可能包含仍有使用价值的数据，也可能被桌面快捷方式引用。清理前必须先核对运行进程、快捷方式目标、最近使用时间和是否已有可验证的源码/发布备份。

## 固定工作流

1. 执行 `git fetch origin --prune`，核对远端基线。
2. 检查 `git status --short --branch` 和 `git worktree list`。
3. 在职责匹配的干净 worktree 中修改。
4. 运行与变更范围相符的测试或构建。
5. 检查暂存文件，确认没有生成物、密钥或个人数据。
6. 用一个提交记录一个逻辑变更，再推送对应责任分支。

`main` 只接收已经完成源码归位、测试和审查的合并结果，不作为本地运行时目录或临时文件的收纳区。
