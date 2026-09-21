# 在场插件包规范

PC Agent 支持由用户明确导入的插件 ZIP。插件必须在根目录提供 `plugin.json` 和入口文件；宿主会校验名称、版本、能力、权限、平台、出站域名以及输入输出 schema。插件默认停用，代码在独立进程中运行，宿主负责权限和网络边界。

本分支没有内置校园、天气、地图或定位 Provider，也不随源码提供这些领域的插件示例。插件安装、升级和卸载都需要用户在设置页确认，并在重启后生效。

示例清单：

```json
{
  "id": "example.local.read",
  "version": "1.0.0",
  "displayName": "本地示例接口",
  "description": "只读返回用户明确配置的本地数据。",
  "entry": "index.mjs",
  "platforms": ["win32"],
  "egressHosts": [],
  "capabilities": []
}
```

插件不能提升 Agent 当前回合的权限，也不能读取任意文件路径或绕过宿主脱敏。完整实现见 `src/main/plugins/`、`src/main/interfaces/` 和 `src/main/capabilities/`。
