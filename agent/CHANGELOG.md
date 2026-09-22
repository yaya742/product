# 变更记录

## 2026-09-17：DeepSeek 连接与冷启动修复

- “连接 DeepSeek”现在会先发起真实请求，只有接口验证成功后才保存 API Key。
- 无效密钥、余额不足、网络失败、超时、协议错误和 Agent 运行时错误会显示可操作原因，不再统一显示为“处理中断”。
- 冷启动回归覆盖“你能为我做什么”从控制解析、Hermes 启动到模型回复的完整链路。
- Windows 下插件子进程关闭时会连同其 Electron 子进程树一起退出，避免升级或卸载后的目录占用。
- 天气插件继续遵守显式天气权限和本机定位权限；本机位置只在用户允许时按本轮使用，不写入长期资料。

### 验证结果

- `npm test`：28/28
- `npm run test:plugins`：10/10
- `npm run test:weather-gps`：3/3
- `npm run test:cold-start`：通过
- `node tests/package.mjs`：通过

本记录不包含 API Key、用户数据库、对话内容或构建产物。
