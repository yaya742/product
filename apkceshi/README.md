# 在场移动端（本地直连版）

这是与 Windows 桌面版分开的移动端代码目录。它不依赖 `D:\product\zaichang\zaichang` 的 Electron 源码，也不需要部署在场云服务器。

## 当前切片

- 用户在手机端填写自己的 DeepSeek API Key。
- 手机直接请求 `https://api.deepseek.com/chat/completions`，模型 ID 固定为 `deepseek-flash`。
- 对话和手动保存的记忆保存在本机。
- 支持多个本地对话、AI 自动总结标题、历史记录重命名和删除。
- 对齐 PC 端的本地安排能力：Agent 可按明确委托登记安排，手机端可查看、完成或撤销；不代表外部服务已预约或送达。
- 支持按本轮设置资料范围：按需参考、不参考历史/记忆、只看当前附件，以及保留对话但不形成长期记忆或本轮不保存。
- 支持导出本机资料（排除 API Key 和校园密码）与清空本机资料。
- 支持个人设置：头像、界面语言、浅色/深色主题，以及本地校园信息。
- Agent 可以按需读取手机本地时间和一次性 GPS；定位结果不会自动写入长期记忆。
- 内置紫金港校园离线地图：地点搜索、手机定位和本地步行路线规划；地图数据来自随包的 OSM 快照，不代表实时门禁或通行保证。
- 支持天气面板和对话内天气查询：默认使用紫金港参考位置，也可以使用手机当前位置；天气由手机直连 Open-Meteo，不需要部署服务器。
- 使用 SSE 流式回复，支持停止当前请求。
- APK 运行时使用 Capacitor 原生 HTTP 请求，绕过 WebView 跨域限制；浏览器预览继续使用 SSE。
- 已预留 Capacitor 配置，后续可生成 Android/iOS 容器。

浏览器预览继续使用 `localStorage` 保存 Key；原生 Android/iOS 运行时会将 API Key 和校园密码迁移到 Capacitor Preferences，业务状态中不再持久化这两个字段。正式发布前仍应进一步审计 Preferences 的平台保护、备份、日志和崩溃路径；不能把 Key 写进源码或发布包。

## 运行

```powershell
npm install
npm run dev
```

浏览器手机虚拟机（不需要真机或 Android 模拟器）：

```powershell
npm run dev:vm
```

它会把同一份移动端 `App` 放进可切换的 Android/iPhone 手机壳中，支持屏幕尺寸、横竖屏、断网、定位不可用和虚拟键盘测试。它模拟的是移动端 UI 与部分设备能力，不是完整 Android 操作系统；DeepSeek、天气和校园请求会按测试开关执行。

构建移动端网页资源：

```powershell
npm run build
```

如果本机安装了 Android Studio、JDK 和 Android SDK，可以继续：

```powershell
npx cap add android
npm run cap:sync
npm run cap:android
```

## 边界

这一版的地图、天气、校园资料、提醒和本地安排通过移动端适配器运行，不依赖 Electron 或 Windows 子进程。PC 的 SQLite/Harness/插件宿主、跨设备同步、外部发送与真实账号/设备验收仍不属于 APK 本地实现范围。
