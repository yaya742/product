# 在场移动端（本地直连版）

这是与 Windows 桌面版分开的移动端代码目录。它不依赖 `D:\product\zaichang\zaichang` 的 Electron 源码，也不需要部署在场云服务器。

## 当前切片

- 用户在手机端填写自己的 DeepSeek API Key。
- 手机直接请求 `https://api.deepseek.com/chat/completions`，模型 ID 固定为 `deepseek-flash`。
- 对话和手动保存的记忆保存在本机。
- 支持多个本地对话、AI 自动总结标题、历史记录重命名和删除。
- 支持个人设置：头像、界面语言、浅色/深色主题，以及本地校园信息。
- Agent 可以按需读取手机本地时间和一次性 GPS；定位结果不会自动写入长期记忆。
- 内置紫金港校园离线地图：地点搜索、手机定位和本地步行路线规划；地图数据来自随包的 OSM 快照，不代表实时门禁或通行保证。
- 支持天气面板和对话内天气查询：默认使用紫金港参考位置，也可以使用手机当前位置；天气由手机直连 Open-Meteo，不需要部署服务器。
- 使用 SSE 流式回复，支持停止当前请求。
- APK 运行时使用 Capacitor 原生 HTTP 请求，绕过 WebView 跨域限制；浏览器预览继续使用 SSE。
- 已预留 Capacitor 配置，后续可生成 Android/iOS 容器。

当前浏览器预览使用 `localStorage` 保存 Key；正式 Android/iOS 构建时应将 `src/runtime/storage.ts` 接到 `@capacitor/preferences` 或原生 Keystore/Keychain，不能把 Key 写进源码或发布包。

## 运行

```powershell
npm install
npm run dev
```

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

这一版的地图和天气通过移动端适配器运行，不依赖 Electron 或 Windows 子进程。校园资料的实际业务接入、系统通知和完整的 Harness 行动链仍未接入移动端。
