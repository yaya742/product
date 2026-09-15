# 在场第三方插件包规范

接口管理器支持从设置页安装 ZIP 插件包。插件包不会写入源码，保存在当前用户的在场数据目录中；安装、升级、卸载完成后关闭并重新打开在场即可切换版本。天气不是宿主内置 Provider，而是仓库中的可安装示例插件，打包命令为 `npm run package:weather`，生成 `artifacts/weather-plugin.zip`。

## 包结构

```text
my-plugin.zip
├── plugin.json
└── index.mjs
```

`plugin.json` 示例：

```json
{
  "apiVersion": 1,
  "id": "campus.example",
  "version": "1.0.0",
  "displayName": "示例校园服务",
  "description": "读取示例校园服务中的公开信息。",
  "entry": "index.mjs",
  "capabilities": [
    {
      "name": "campus.example.lookup",
      "displayName": "查询示例信息",
      "description": "按参数读取信息，不执行写操作。",
      "version": "1.0.0",
      "effect": "read",
      "requiredScopes": ["campus:read"],
      "subjects": ["self"],
      "worlds": ["real"],
      "timeoutMs": 15000,
      "maxBytes": 80000,
      "supportsIdempotency": false,
      "supportsInspect": false,
      "supportsCancel": false,
      "inputSchema": {
        "type": "object",
        "required": ["query"],
        "properties": { "query": { "type": "string", "minLength": 1 } },
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "required": ["data"],
        "properties": { "data": { "type": "object" } },
        "additionalProperties": false
      }
    }
  ],
  "egressHosts": ["api.example.com"],
  "platforms": ["win32"],
  "offline": "unsupported",
  "license": "MIT"
}
```

入口脚本默认导出一个对象，方法参数统一为 `{ name, args, key, context }`。`context.request(url, init)` 是经过在场权限、出站域名和请求方式检查的网络通道；插件不应依赖环境变量中的密钥，也不应绕过这个通道直接发送请求。

```js
export default {
  async invoke({ name, args, context }) {
    const response = await context.request('https://api.example.com/weather?q=' + encodeURIComponent(args.query));
    const data = await response.json();
    return {
      status: 'fresh',
      sourceId: 'plugin:campus.example',
      data,
      simulated: false
    };
  }
};
```

第三方插件首次安装后默认停用，用户需要在接口列表中明确启用。插件代码在独立进程中运行，宿主不向插件子进程传递 DeepSeek 密钥；插件结果仍必须通过能力声明、资料范围、权限、输入 schema、输出 schema 和输出预算检查。`inputSchema`/`outputSchema` 是 Agent 的能力发现契约，宿主会校验其声明的对象、数组、类型、范围、必填字段和额外字段。`external_write` 能力还必须经过在场动作审批和幂等键校验。

天气示例声明 `weather.lookup`、`weather.forecast` 和 `weather.outdoor_activity`。Agent 的 `look_up(source="weather")` 只解析为已安装插件提供的 `weather.lookup`；插件不存在、停用、权限不足或返回不完整数据时，宿主返回明确的 `unsupported`/`forbidden`/`failed` 状态，不会回退到隐藏的内置天气实现。Windows 定位由宿主完成权限检查后注入坐标，插件只接收标准参数，因此同一插件可以在不同桌面平台复用。

独立进程不是完整的 Windows OS 沙箱，插件包仍可能访问它自己的进程权限范围；因此只安装你信任的来源。宿主会隔离密钥、限制插件通过 `context.request` 发出的网络目标，并在插件失控时终止其进程。

版本升级要求新版本号高于当前已安装版本。升级和卸载会保留当前运行版本到应用退出，重启后才完成切换或删除，避免半更新状态影响正在进行的对话。
